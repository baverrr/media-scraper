using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Jellyfin.Plugin.LocalBroadcast.Configuration;

/// <summary>
/// Checks market files you add as your own markets (the same format as the bundled ones), and
/// picks their ids.
/// </summary>
public static partial class MarketFile
{
    /// <summary>
    /// The largest market file accepted, in characters.
    /// </summary>
    public const int MaxLength = 1_000_000;

    /// <summary>
    /// Checks a market file.
    /// </summary>
    /// <param name="json">The file's JSON.</param>
    /// <param name="market">The parsed market, when valid.</param>
    /// <returns>What's wrong with it, or null when it's valid.</returns>
    public static string? Check(string? json, out Market? market)
    {
        market = null;
        if (string.IsNullOrWhiteSpace(json))
        {
            return "The market file is empty.";
        }

        if (json.Length > MaxLength)
        {
            return "The market file is too large.";
        }

        // Jellyfin keeps your markets in its XML settings file, which can't hold these.
        if (json.Any(c => c is '\uFFFE' or '\uFFFF' || (char.IsControl(c) && c is not '\t' and not '\n' and not '\r')))
        {
            return "The market file contains characters that can't be saved in Jellyfin's settings.";
        }

        Market parsed;
        try
        {
            parsed = Market.Parse(json);
        }
        catch (JsonException e)
        {
            return JsonProblem(e);
        }

        if (string.IsNullOrWhiteSpace(parsed.Name))
        {
            return "The market file needs a \"name\".";
        }

        if (parsed.Stations.Count == 0)
        {
            return "The market file has no stations (each needs at least an \"id\" and a \"url\").";
        }

        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var s in parsed.Stations)
        {
            if (!StationId().IsMatch(s.Id) || s.Id == "local-sports")
            {
                return $"Station id \"{s.Id}\" isn't valid: use lowercase letters, digits, - and _.";
            }

            if (!seen.Add(s.Id))
            {
                return $"Station id \"{s.Id}\" appears twice.";
            }

            if (!IsHttpUrl(s.Url))
            {
                return $"Station \"{s.Id}\" needs a full http(s) \"url\" for its live-stream page.";
            }

            foreach (var (field, value) in new[] { ("streamUrl", s.StreamUrl), ("signInUrl", s.SignInUrl), ("signUpUrl", s.SignUpUrl) })
            {
                if (!string.IsNullOrWhiteSpace(value) && !IsHttpUrl(value))
                {
                    return $"Station \"{s.Id}\": \"{field}\" must be a full http(s) URL.";
                }
            }

            foreach (var b in s.Schedule)
            {
                if (!Time().IsMatch(b.Start) || !Time().IsMatch(b.End) || b.Start == b.End)
                {
                    return $"Station \"{s.Id}\": a newscast needs different \"start\" and \"end\" times as HH:MM.";
                }

                if (b.Days.Count == 0 || b.Days.Any(d => !IsDay(d)))
                {
                    return $"Station \"{s.Id}\": newscast days must be mon to sun, weekdays, weekends or daily.";
                }
            }
        }

        foreach (var t in parsed.Teams)
        {
            if (!Leagues.Contains(t.League.Trim().ToLowerInvariant()))
            {
                return $"Team \"{t.Name}\": unknown league \"{t.League}\" (one of {string.Join(", ", Leagues)}).";
            }

            if (!TeamId().IsMatch(t.Team.Trim()))
            {
                return $"Team \"{t.Name}\": \"team\" must be an ESPN team id or abbreviation.";
            }
        }

        market = parsed;
        return null;
    }

    /// <summary>
    /// An id for a new market of your own: its name as lowercase words joined by -, made unique
    /// against the bundled markets and your others.
    /// </summary>
    /// <param name="name">The market's name.</param>
    /// <param name="config">The settings holding your own markets.</param>
    /// <returns>The id.</returns>
    public static string NewId(string name, PluginConfiguration config)
    {
        var slug = NotIdChars().Replace((name ?? string.Empty).ToLowerInvariant(), "-").Trim('-');
        if (slug.Length == 0)
        {
            slug = "market";
        }

        if (slug.Length > 48)
        {
            slug = slug[..48].TrimEnd('-');
        }

        var taken = new HashSet<string>(Market.Ids().Concat(config.CustomMarkets.Select(c => c.Id)), StringComparer.OrdinalIgnoreCase) { "combined" };
        var id = slug;
        for (var n = 2; taken.Contains(id); n++)
        {
            id = $"{slug}-{n}";
        }

        return id;
    }

    // The leagues the sidecar knows (sidecar/src/sports.js LEAGUES).
    private static readonly string[] Leagues = ["nfl", "ncaaf", "nba", "wnba", "ncaam", "ncaaw", "nhl", "mlb", "mls", "nwsl"];

    private static readonly string[] DayNames = ["sun", "mon", "tue", "wed", "thu", "fri", "sat", "daily", "weekdays", "weekends"];

    // A parse error in plain words: where it is, and for a value of the wrong kind (a list where
    // text belongs, say) what belongs there, instead of the serializer's .NET type names.
    private static string JsonProblem(JsonException e)
    {
        var where = e.LineNumber is { } line ? $" (line {line + 1}, column {(e.BytePositionInLine ?? 0) + 1})" : string.Empty;
        var path = e.Path is null or "$" ? null : e.Path.StartsWith("$.", StringComparison.Ordinal) ? e.Path[2..] : e.Path;
        var wrongKind = WrongKind().Match(e.Message);
        if (wrongKind.Success)
        {
            var field = path is null ? "The market file" : $"\"{path}\"";
            return $"{field} should be {Kind(wrongKind.Groups[1].Value)}{where}.";
        }

        // System.Text.Json ends its messages with " Path: $ | LineNumber: 0 | BytePositionInLine: 0.".
        var message = e.Message;
        var cut = message.IndexOf(" Path: ", StringComparison.Ordinal);
        if (cut >= 0)
        {
            message = message[..cut];
        }

        return $"The market file isn't valid JSON{where}: {message.TrimEnd('.')}.";
    }

    private static string Kind(string type) => type switch
    {
        "System.String" => "text in quotes",
        "System.Boolean" => "true or false",
        "System.Int32" or "System.Int64" or "System.Double" or "System.Decimal" or "System.Single" => "a number",
        _ when type.StartsWith("System.Nullable`1[", StringComparison.Ordinal) => Kind(type[18..^1]),
        _ when type.StartsWith("System.Collections.Generic.", StringComparison.Ordinal) || type.EndsWith("[]", StringComparison.Ordinal) => "a list in [ ]",
        _ => "an object in { }",
    };

    private static bool IsHttpUrl(string? value)
        => Uri.TryCreate(value, UriKind.Absolute, out var url) && (url.Scheme == Uri.UriSchemeHttp || url.Scheme == Uri.UriSchemeHttps);

    // As the sidecar reads them: "weekdays", or a day by its first three letters ("Monday").
    private static bool IsDay(string day)
    {
        var d = day.Trim().ToLowerInvariant();
        return DayNames.Contains(d) || (d.Length > 3 && DayNames.Take(7).Contains(d[..3]));
    }

    [GeneratedRegex("^([01][0-9]|2[0-3]):[0-5][0-9]$")]
    private static partial Regex Time();

    [GeneratedRegex("^[A-Za-z0-9-]{1,32}$")]
    private static partial Regex TeamId();

    [GeneratedRegex("^[a-z0-9][a-z0-9_-]{0,63}$")]
    private static partial Regex StationId();

    [GeneratedRegex("could not be converted to (\\S+?)\\. Path:")]
    private static partial Regex WrongKind();

    [GeneratedRegex("[^a-z0-9]+")]
    private static partial Regex NotIdChars();
}
