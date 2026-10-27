using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;
using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.LocalBroadcast.Configuration;

/// <summary>
/// A local broadcast station whose website carries a live stream.
/// </summary>
public class Station
{
    /// <summary>
    /// Gets or sets the stable id (lowercase letters, digits, - and _), used as the guide channel id.
    /// </summary>
    public string Id { get; set; } = string.Empty;

    /// <summary>
    /// Gets or sets the FCC call sign, e.g. KUSA.
    /// </summary>
    public string CallSign { get; set; } = string.Empty;

    /// <summary>
    /// Gets or sets the display name, e.g. 9NEWS.
    /// </summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>
    /// Gets or sets the virtual channel number, e.g. 9.1.
    /// </summary>
    public string Channel { get; set; } = string.Empty;

    /// <summary>
    /// Gets or sets the network affiliation, e.g. NBC. Also used to match local games to the station.
    /// </summary>
    public string Network { get; set; } = string.Empty;

    /// <summary>
    /// Gets or sets the station's live-stream web page.
    /// </summary>
    public string Url { get; set; } = string.Empty;

    /// <summary>
    /// Gets or sets an optional stream to use instead of scraping the page: a live HLS/DASH URL,
    /// or a page yt-dlp supports.
    /// </summary>
    public string? StreamUrl { get; set; }

    /// <summary>
    /// Gets or sets the page with the site's sign-in form, for a station that streams only to
    /// signed-in accounts. The account itself is saved in the sidecar, encrypted, never here.
    /// </summary>
    public string? SignInUrl { get; set; }

    /// <summary>
    /// Gets or sets where to create an account on the station's site, linked from the settings page.
    /// </summary>
    public string? SignUpUrl { get; set; }

    /// <summary>
    /// Gets or sets an optional logo image URL.
    /// </summary>
    public string? Logo { get; set; }

    /// <summary>
    /// Gets or sets the station's city, e.g. Pueblo, CO.
    /// </summary>
    public string? City { get; set; }

    /// <summary>
    /// Gets or sets the latitude of the station's city, for the coverage radius.
    /// </summary>
    public double? Latitude { get; set; }

    /// <summary>
    /// Gets or sets the longitude of the station's city, for the coverage radius.
    /// </summary>
    public double? Longitude { get; set; }

    /// <summary>
    /// Gets or sets extra broadcaster names, comma separated, that mean a game airs on this
    /// station (e.g. "Altitude Sports" for a station simulcasting Altitude games).
    /// </summary>
    public string? SportsAliases { get; set; }

    /// <summary>
    /// Gets or sets a note from the market file, e.g. why the station is disabled.
    /// </summary>
    public string? Note { get; set; }

    /// <summary>
    /// Gets or sets a value indicating whether the station appears in Live TV.
    /// </summary>
    public bool Enabled { get; set; } = true;
}

/// <summary>
/// A local team whose games put the station airing them first.
/// </summary>
public class SportsTeam
{
    /// <summary>
    /// Gets or sets the league: nfl, nba, wnba, nhl, mlb, mls, nwsl, ncaaf, ncaam or ncaaw.
    /// </summary>
    public string League { get; set; } = string.Empty;

    /// <summary>
    /// Gets or sets ESPN's team id or abbreviation (e.g. den, or 38 for Colorado).
    /// </summary>
    public string Team { get; set; } = string.Empty;

    /// <summary>
    /// Gets or sets the display name.
    /// </summary>
    public string Name { get; set; } = string.Empty;
}

/// <summary>
/// Plugin configuration.
/// </summary>
public class PluginConfiguration : BasePluginConfiguration
{
    /// <summary>
    /// Gets or sets the sidecar's base URL as Jellyfin reaches it.
    /// </summary>
    public string SidecarUrl { get; set; } = "http://127.0.0.1:8899";

    /// <summary>
    /// Gets or sets the sidecar's API key (its API_KEY environment variable).
    /// </summary>
    public string ApiKey { get; set; } = string.Empty;

    /// <summary>
    /// Gets or sets the market whose defaults were (or will be) loaded.
    /// </summary>
    public string Market { get; set; } = "denver";

    /// <summary>
    /// Gets or sets the stations. Empty until seeded from the market defaults on first start.
    /// </summary>
    public Collection<Station> Stations { get; set; } = new();

    /// <summary>
    /// Gets or sets a value indicating whether the market defaults were added. Seeding happens
    /// once, so deleting every station or team doesn't bring the defaults back on restart.
    /// </summary>
    public bool StationsSeeded { get; set; }

    /// <summary>
    /// Gets or sets a value indicating whether stations airing local games come first, with a
    /// Local Sports channel.
    /// </summary>
    public bool SportsEnabled { get; set; } = true;

    /// <summary>
    /// Gets or sets the Local Sports channel number.
    /// </summary>
    public string SportsChannel { get; set; } = "1.1";

    /// <summary>
    /// Gets or sets the local teams.
    /// </summary>
    public Collection<SportsTeam> Teams { get; set; } = new();

    /// <summary>
    /// Gets or sets a value indicating whether the plugin adds and maintains the Live TV tuner and
    /// guide entries itself.
    /// </summary>
    public bool ManageLiveTv { get; set; } = true;

    /// <summary>
    /// Gets or sets the latitude coverage distances are measured from. Unset uses the market's center.
    /// </summary>
    public double? HomeLatitude { get; set; }

    /// <summary>
    /// Gets or sets the longitude coverage distances are measured from. Unset uses the market's center.
    /// </summary>
    public double? HomeLongitude { get; set; }

    /// <summary>
    /// Gets or sets the coverage radius in miles: enabled stations farther away stay out of Live TV.
    /// 0 means no limit. Stations without a location are always included.
    /// </summary>
    public int MaxDistanceMiles { get; set; }
}

/// <summary>
/// A place: a market's center.
/// </summary>
public class GeoPoint
{
    /// <summary>
    /// Gets or sets the city, e.g. Denver, CO.
    /// </summary>
    public string? City { get; set; }

    /// <summary>
    /// Gets or sets the latitude.
    /// </summary>
    public double Latitude { get; set; }

    /// <summary>
    /// Gets or sets the longitude.
    /// </summary>
    public double Longitude { get; set; }
}

/// <summary>
/// A bundled market: its stations and local teams (sidecar/markets/*.json, embedded at build time).
/// </summary>
public class Market
{
    private const string ResourcePrefix = "Jellyfin.Plugin.LocalBroadcast.markets.";

    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNameCaseInsensitive = true };

    /// <summary>
    /// Gets or sets the market id (its file name).
    /// </summary>
    public string Id { get; set; } = string.Empty;

    /// <summary>
    /// Gets or sets the display name.
    /// </summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>
    /// Gets or sets the Local Sports channel number.
    /// </summary>
    public string? SportsChannel { get; set; }

    /// <summary>
    /// Gets or sets the market's center, where coverage distances are measured from by default.
    /// </summary>
    public GeoPoint? Center { get; set; }

    /// <summary>
    /// Gets or sets the stations.
    /// </summary>
    public List<Station> Stations { get; set; } = [];

    /// <summary>
    /// Gets or sets the local teams.
    /// </summary>
    public List<SportsTeam> Teams { get; set; } = [];

    /// <summary>
    /// Lists the bundled market ids.
    /// </summary>
    /// <returns>Market ids.</returns>
    public static IReadOnlyList<string> Ids()
        => typeof(Market).Assembly.GetManifestResourceNames()
            .Where(n => n.StartsWith(ResourcePrefix, StringComparison.Ordinal) && n.EndsWith(".json", StringComparison.Ordinal))
            .Select(n => n[ResourcePrefix.Length..^".json".Length])
            .OrderBy(n => n, StringComparer.Ordinal)
            .ToList();

    /// <summary>
    /// Loads a bundled market.
    /// </summary>
    /// <param name="id">The market id.</param>
    /// <returns>The market, or null if there is none with that id.</returns>
    public static Market? Load(string id)
    {
        using var stream = typeof(Market).Assembly.GetManifestResourceStream(ResourcePrefix + id + ".json");
        if (stream is null)
        {
            return null;
        }

        using var reader = new StreamReader(stream);
        var market = Parse(reader.ReadToEnd());
        market.Id = id;
        return market;
    }

    /// <summary>
    /// Parses a market file (the sidecar's JSON format).
    /// </summary>
    /// <param name="json">The JSON.</param>
    /// <returns>The market.</returns>
    public static Market Parse(string json)
    {
        var raw = JsonSerializer.Deserialize<RawMarket>(json, JsonOptions) ?? new RawMarket();
        return new Market
        {
            Name = raw.Name ?? string.Empty,
            SportsChannel = raw.SportsChannel,
            Center = raw.Center,
            Stations = (raw.Stations ?? []).Where(s => !string.IsNullOrWhiteSpace(s.Id)).Select(s => s.ToStation()).ToList(),
            Teams = (raw.Teams ?? []).Where(t => !string.IsNullOrWhiteSpace(t.League) && !string.IsNullOrWhiteSpace(t.Team)).ToList(),
        };
    }

    private sealed class RawMarket
    {
        public string? Name { get; set; }

        public string? SportsChannel { get; set; }

        public GeoPoint? Center { get; set; }

        public List<RawStation>? Stations { get; set; }

        public List<SportsTeam>? Teams { get; set; }
    }

    // sportsAliases is a JSON array in the market files and a comma-separated string in the plugin.
    private sealed class RawStation
    {
        public string Id { get; set; } = string.Empty;

        public string CallSign { get; set; } = string.Empty;

        public string Name { get; set; } = string.Empty;

        public string Channel { get; set; } = string.Empty;

        public string Network { get; set; } = string.Empty;

        public string Url { get; set; } = string.Empty;

        public string? StreamUrl { get; set; }

        public string? SignInUrl { get; set; }

        public string? SignUpUrl { get; set; }

        public string? Logo { get; set; }

        public string? City { get; set; }

        public double? Latitude { get; set; }

        public double? Longitude { get; set; }

        [JsonPropertyName("sportsAliases")]
        public List<string>? SportsAliases { get; set; }

        public string? Note { get; set; }

        public bool Enabled { get; set; } = true;

        public Station ToStation() => new()
        {
            Id = Id,
            CallSign = CallSign,
            Name = Name,
            Channel = Channel,
            Network = Network,
            Url = Url,
            StreamUrl = StreamUrl,
            SignInUrl = SignInUrl,
            SignUpUrl = SignUpUrl,
            Logo = Logo,
            City = City,
            Latitude = Latitude,
            Longitude = Longitude,
            SportsAliases = SportsAliases is { Count: > 0 } ? string.Join(", ", SportsAliases) : null,
            Note = Note,
            Enabled = Enabled,
        };
    }
}
