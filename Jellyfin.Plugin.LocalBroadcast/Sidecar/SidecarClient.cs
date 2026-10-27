using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Json;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.LocalBroadcast.Configuration;

namespace Jellyfin.Plugin.LocalBroadcast.Sidecar;

/// <summary>
/// Talks to the local-broadcast sidecar's HTTP API.
/// </summary>
public class SidecarClient
{
    internal static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    private readonly IHttpClientFactory _httpClientFactory;

    public SidecarClient(IHttpClientFactory httpClientFactory)
    {
        _httpClientFactory = httpClientFactory;
    }

    /// <summary>
    /// Builds the sidecar URL for a path, from the configured base URL.
    /// </summary>
    /// <param name="config">The plugin configuration.</param>
    /// <param name="path">The path, starting with a slash.</param>
    /// <returns>The absolute URL.</returns>
    public static string UrlFor(PluginConfiguration config, string path)
        => (config.SidecarUrl ?? string.Empty).Trim().TrimEnd('/') + path;

    /// <summary>
    /// Builds the sidecar URL for a request, rejecting a sidecar URL that isn't a full http(s)
    /// address: "localhost:8899" parses as a URI with the scheme "localhost", and an empty one as a
    /// relative URI, and HttpClient throws exceptions for those that the settings page can't show.
    /// </summary>
    /// <param name="config">The plugin configuration.</param>
    /// <param name="path">The path, starting with a slash.</param>
    /// <returns>The absolute URI.</returns>
    /// <exception cref="HttpRequestException">The sidecar URL is not a full http(s) address.</exception>
    public static Uri RequestUri(PluginConfiguration config, string path)
    {
        if (Uri.TryCreate(UrlFor(config, path), UriKind.Absolute, out var uri)
            && (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps))
        {
            return uri;
        }

        throw new HttpRequestException($"The sidecar URL \"{config.SidecarUrl}\" is not a full address; use one like http://127.0.0.1:8899.");
    }

    /// <summary>
    /// The station list in the sidecar's JSON shape (camelCase, logo null when empty). Stations
    /// outside the coverage radius are sent disabled, with a note saying so.
    /// </summary>
    /// <param name="config">The plugin configuration.</param>
    /// <returns>Objects ready to serialize.</returns>
    public static IReadOnlyList<object> ToSidecarStations(PluginConfiguration config)
    {
        var home = config.MaxDistanceMiles > 0 ? Coverage.Home(config) : null;
        return config.Stations.Select(s =>
        {
            var inRange = Coverage.InRange(config, home, s);
            var note = string.IsNullOrWhiteSpace(s.Note) ? null : s.Note;
            if (s.Enabled && !inRange)
            {
                note = $"Outside the {config.MaxDistanceMiles}-mile coverage radius ({Coverage.DistanceMiles(home, s):0} miles away).";
            }

            return (object)new
            {
                id = s.Id.Trim().ToLowerInvariant(),
                callSign = s.CallSign,
                name = s.Name,
                channel = s.Channel,
                network = s.Network,
                url = s.Url,
                streamUrl = string.IsNullOrWhiteSpace(s.StreamUrl) ? null : s.StreamUrl.Trim(),
                logo = string.IsNullOrWhiteSpace(s.Logo) ? null : s.Logo,
                sportsAliases = (s.SportsAliases ?? string.Empty).Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries),
                note,
                enabled = s.Enabled && inRange,
            };
        }).ToList();
    }

    /// <summary>
    /// The sports settings in the sidecar's JSON shape.
    /// </summary>
    /// <param name="config">The plugin configuration.</param>
    /// <returns>An object ready to serialize.</returns>
    public static object ToSidecarSports(PluginConfiguration config) => new
    {
        enabled = config.SportsEnabled,
        channel = string.IsNullOrWhiteSpace(config.SportsChannel) ? "1.1" : config.SportsChannel.Trim(),
        teams = config.Teams.Select(t => new { league = t.League.Trim().ToLowerInvariant(), team = t.Team.Trim(), name = t.Name }).ToList(),
    };

    /// <summary>
    /// Replaces the sidecar's station list.
    /// </summary>
    /// <param name="config">The plugin configuration.</param>
    /// <param name="cancellationToken">The cancellation token.</param>
    /// <returns>A task.</returns>
    public async Task PushStationsAsync(PluginConfiguration config, CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Put, RequestUri(config, "/api/stations"))
        {
            Content = JsonContent.Create(ToSidecarStations(config), options: JsonOptions),
        };
        await SendAsync(config, request, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>
    /// Replaces the sidecar's sports settings (on/off, Local Sports channel number, teams).
    /// </summary>
    /// <param name="config">The plugin configuration.</param>
    /// <param name="cancellationToken">The cancellation token.</param>
    /// <returns>A task.</returns>
    public async Task PushSportsAsync(PluginConfiguration config, CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Put, RequestUri(config, "/api/sports"))
        {
            Content = JsonContent.Create(ToSidecarSports(config), options: JsonOptions),
        };
        await SendAsync(config, request, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>
    /// Gets local games on the air now and coming up, with the station airing each.
    /// </summary>
    /// <param name="config">The plugin configuration.</param>
    /// <param name="cancellationToken">The cancellation token.</param>
    /// <returns>The sidecar's sports state.</returns>
    public async Task<JsonElement> SportsAsync(PluginConfiguration config, CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, RequestUri(config, "/api/sports"));
        return await SendAsync(config, request, cancellationToken, TimeSpan.FromSeconds(45)).ConfigureAwait(false);
    }

    /// <summary>
    /// Resolves a station now, bypassing the sidecar's cache.
    /// </summary>
    /// <param name="config">The plugin configuration.</param>
    /// <param name="stationId">The station id.</param>
    /// <param name="cancellationToken">The cancellation token.</param>
    /// <returns>The sidecar's test result (ok, via, url or error, details).</returns>
    public async Task<JsonElement> TestAsync(PluginConfiguration config, string stationId, CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, RequestUri(config, "/api/stations/" + Uri.EscapeDataString(stationId) + "/test"));
        return await SendAsync(config, request, cancellationToken, TimeSpan.FromMinutes(3)).ConfigureAwait(false);
    }

    /// <summary>
    /// Gets each station's resolution state.
    /// </summary>
    /// <param name="config">The plugin configuration.</param>
    /// <param name="cancellationToken">The cancellation token.</param>
    /// <returns>The sidecar's status array.</returns>
    public async Task<JsonElement> StatusAsync(PluginConfiguration config, CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, RequestUri(config, "/api/status"));
        return await SendAsync(config, request, cancellationToken).ConfigureAwait(false);
    }

    private async Task<JsonElement> SendAsync(PluginConfiguration config, HttpRequestMessage request, CancellationToken cancellationToken, TimeSpan? timeout = null)
    {
        // Trimmed: a key pasted with a trailing space or newline would otherwise be rejected (or,
        // with Headers.Add, throw before the request is sent).
        var apiKey = config.ApiKey?.Trim();
        if (!string.IsNullOrEmpty(apiKey))
        {
            request.Headers.TryAddWithoutValidation("X-Api-Key", apiKey);
        }

        using var cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        cts.CancelAfter(timeout ?? TimeSpan.FromSeconds(20));
        var client = _httpClientFactory.CreateClient();
        client.Timeout = System.Threading.Timeout.InfiniteTimeSpan; // the linked token handles it
        using var response = await client.SendAsync(request, cts.Token).ConfigureAwait(false);
        var body = await response.Content.ReadAsStringAsync(cts.Token).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
        {
            throw new SidecarException((int)response.StatusCode, ErrorMessage(body) ?? response.ReasonPhrase ?? "request failed");
        }

        try
        {
            using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(body) ? "null" : body);
            return doc.RootElement.Clone();
        }
        catch (JsonException)
        {
            // Something else answered: a web page on that port, or a reverse proxy's login page.
            throw new HttpRequestException($"{request.RequestUri} did not answer like the Local Broadcast sidecar (the response is not JSON). Check the sidecar URL.");
        }
    }

    private static string? ErrorMessage(string body)
    {
        try
        {
            using var doc = JsonDocument.Parse(body);
            return doc.RootElement.TryGetProperty("error", out var e) ? e.GetString() : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }
}

/// <summary>
/// The sidecar answered with an error status.
/// </summary>
public class SidecarException : Exception
{
    public SidecarException(int status, string message)
        : base($"Sidecar returned HTTP {status}: {message}")
    {
        Status = status;
    }

    /// <summary>
    /// Gets the HTTP status code.
    /// </summary>
    public int Status { get; }
}
