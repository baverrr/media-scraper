using System;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.LocalBroadcast.Configuration;
using Jellyfin.Plugin.LocalBroadcast.Sidecar;
using MediaBrowser.Common.Api;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.LocalBroadcast.Api;

/// <summary>
/// Settings-page endpoints: test a station, show sidecar status, sync now, read the defaults.
/// </summary>
[ApiController]
[Route("LocalBroadcast")]
[Authorize(Policy = Policies.RequiresElevation)]
public class LocalBroadcastController : ControllerBase
{
    private readonly SidecarClient _sidecar;
    private readonly SyncService _sync;

    public LocalBroadcastController(SidecarClient sidecar, SyncService sync)
    {
        _sidecar = sidecar;
        _sync = sync;
    }

    private static PluginConfiguration Config => Plugin.Instance?.Configuration ?? throw new InvalidOperationException("Plugin not loaded");

    /// <summary>
    /// Resolves a saved station now, the way playback would, and reports what was found or why not.
    /// </summary>
    /// <param name="id">The station id.</param>
    /// <param name="cancellationToken">The cancellation token.</param>
    /// <returns>The sidecar's test result.</returns>
    [HttpPost("Test/{id}")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<ActionResult<JsonElement>> Test([FromRoute] string id, CancellationToken cancellationToken)
    {
        try
        {
            return await _sidecar.TestAsync(Config, id, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception e) when (e is HttpRequestException or SidecarException or TaskCanceledException)
        {
            return Ok(new { ok = false, id, error = SidecarProblem(e) });
        }
    }

    /// <summary>
    /// Gets the sidecar's per-station state and the last sync result.
    /// </summary>
    /// <param name="cancellationToken">The cancellation token.</param>
    /// <returns>Status.</returns>
    [HttpGet("Status")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<ActionResult<object>> Status(CancellationToken cancellationToken)
    {
        try
        {
            var stations = await _sidecar.StatusAsync(Config, cancellationToken).ConfigureAwait(false);
            return Ok(new { reachable = true, stations, lastSync = _sync.LastResult });
        }
        catch (Exception e) when (e is HttpRequestException or SidecarException or TaskCanceledException)
        {
            return Ok(new { reachable = false, error = SidecarProblem(e), lastSync = _sync.LastResult });
        }
    }

    /// <summary>
    /// Pushes the stations to the sidecar, checks the Live TV entries and refreshes the guide.
    /// </summary>
    /// <param name="cancellationToken">The cancellation token.</param>
    /// <returns>The sync result.</returns>
    [HttpPost("Sync")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<ActionResult<SyncResult>> Sync(CancellationToken cancellationToken)
        => await _sync.SyncAsync(true, cancellationToken).ConfigureAwait(false);

    /// <summary>
    /// Lists the bundled markets.
    /// </summary>
    /// <returns>Market ids and names.</returns>
    [HttpGet("Markets")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public ActionResult<object> Markets() => Ok(Market.Ids().Select(id => Market.Load(id)).Where(m => m is not null).Select(m => new { m!.Id, m.Name, Stations = m.Stations.Count, Teams = m.Teams.Count }));

    /// <summary>
    /// Gets a bundled market's default stations and teams.
    /// </summary>
    /// <param name="id">The market id.</param>
    /// <returns>The market.</returns>
    [HttpGet("Markets/{id}")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public ActionResult<Market> GetMarket([FromRoute] string id) => Market.Load(id) is { } m ? Ok(m) : NotFound();

    /// <summary>
    /// Gets local games on the air now and coming up, with the station airing each.
    /// </summary>
    /// <param name="cancellationToken">The cancellation token.</param>
    /// <returns>The sidecar's sports state.</returns>
    [HttpGet("Sports")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<ActionResult<object>> Sports(CancellationToken cancellationToken)
    {
        try
        {
            return Ok(await _sidecar.SportsAsync(Config, cancellationToken).ConfigureAwait(false));
        }
        catch (Exception e) when (e is HttpRequestException or SidecarException or TaskCanceledException)
        {
            return Ok(new { error = SidecarProblem(e) });
        }
    }

    private static string SidecarProblem(Exception e) => e switch
    {
        SidecarException s when s.Status == 401 => "The sidecar rejected the API key. Set the same key as the sidecar's API_KEY.",
        SidecarException s => s.Message,
        TaskCanceledException => "The sidecar did not answer in time.",
        _ => $"Could not reach the sidecar at {Config.SidecarUrl}: {e.Message}",
    };
}
