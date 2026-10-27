using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.LocalBroadcast.Configuration;
using Jellyfin.Plugin.LocalBroadcast.LiveTv;
using Jellyfin.Plugin.LocalBroadcast.Sidecar;
using MediaBrowser.Model.Plugins;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.LocalBroadcast;

/// <summary>
/// Pushes the station list to the sidecar and keeps the Live TV entries in place: shortly after
/// startup (retrying while the sidecar is unreachable) and whenever the settings are saved.
/// </summary>
public class SyncService : IHostedService, IDisposable
{
    private static readonly TimeSpan StartupDelay = TimeSpan.FromSeconds(20);
    private static readonly TimeSpan RetryDelay = TimeSpan.FromMinutes(1);
    private static readonly TimeSpan SportsCheckInterval = TimeSpan.FromMinutes(30);
    private const int StartupAttempts = 15;

    private readonly SidecarClient _sidecar;
    private readonly LiveTvRegistrar _registrar;
    private readonly ILogger<SyncService> _logger;
    private readonly SemaphoreSlim _lock = new(1, 1);
    private readonly CancellationTokenSource _stopping = new();
    private readonly PushedStationsRecord _lastStations;
    private string? _lastGames;

    public SyncService(SidecarClient sidecar, LiveTvRegistrar registrar, ILogger<SyncService> logger)
    {
        _sidecar = sidecar;
        _registrar = registrar;
        _logger = logger;
        _lastStations = new PushedStationsRecord(
            () => Plugin.Instance is { } plugin ? Path.Combine(plugin.DataFolderPath, "last-pushed-stations.txt") : null,
            logger);
    }

    /// <summary>
    /// Gets the outcome of the last sync, for the settings page.
    /// </summary>
    public SyncResult? LastResult { get; private set; }

    /// <inheritdoc />
    public Task StartAsync(CancellationToken cancellationToken)
    {
        if (Plugin.Instance is { } plugin)
        {
            plugin.ConfigurationChanged += OnConfigurationChanged;
        }

        _ = Task.Run(() => StartupSyncAsync(_stopping.Token), CancellationToken.None);
        _ = Task.Run(() => SportsLoopAsync(_stopping.Token), CancellationToken.None);
        return Task.CompletedTask;
    }

    /// <inheritdoc />
    public Task StopAsync(CancellationToken cancellationToken)
    {
        if (Plugin.Instance is { } plugin)
        {
            plugin.ConfigurationChanged -= OnConfigurationChanged;
        }

        _stopping.Cancel();
        return Task.CompletedTask;
    }

    /// <summary>
    /// Pushes stations and checks the Live TV entries now.
    /// </summary>
    /// <param name="refreshGuide">Refresh the guide even if nothing changed.</param>
    /// <param name="cancellationToken">The cancellation token.</param>
    /// <returns>The result.</returns>
    public async Task<SyncResult> SyncAsync(bool refreshGuide, CancellationToken cancellationToken)
    {
        await _lock.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            // Read the settings once the lock is held: SemaphoreSlim isn't first-come first-served,
            // so a sync queued with older settings could otherwise run last and push them.
            var config = Plugin.Instance?.Configuration ?? throw new InvalidOperationException("Plugin not loaded");
            var result = new SyncResult { Time = DateTime.UtcNow };
            var stationsJson = JsonSerializer.Serialize(SidecarClient.ToSidecarStations(config.Stations), SidecarClient.JsonOptions)
                + JsonSerializer.Serialize(SidecarClient.ToSidecarSports(config), SidecarClient.JsonOptions);
            try
            {
                await _sidecar.PushStationsAsync(config, cancellationToken).ConfigureAwait(false);
                await _sidecar.PushSportsAsync(config, cancellationToken).ConfigureAwait(false);
                result.SidecarOk = true;
            }
            catch (Exception e) when (e is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
            {
                result.SidecarError = e.Message;
                _logger.LogWarning("Local Broadcast: could not update the sidecar at {Url}: {Message}", config.SidecarUrl, e.Message);
            }

            var registered = false;
            if (config.ManageLiveTv && !result.SidecarOk)
            {
                // Jellyfin downloads the playlist when a tuner is saved, so wait for the sidecar.
                result.LiveTvError = "Waiting for the sidecar before setting up Live TV.";
            }
            else if (config.ManageLiveTv)
            {
                try
                {
                    registered = await _registrar.EnsureAsync(config).ConfigureAwait(false);
                    result.LiveTvOk = true;
                }
                catch (Exception e)
                {
                    result.LiveTvError = e.Message;
                    _logger.LogError(e, "Local Broadcast: could not set up the Live TV tuner and guide");
                }
            }

            // Compared with the last successful push, kept across restarts: stations changed while
            // Jellyfin was down (an upgrade that reseeds them, an edited settings file) refresh the
            // guide too.
            var stationsChanged = result.SidecarOk && _lastStations.Update(stationsJson);

            if (config.ManageLiveTv && result.SidecarOk && (refreshGuide || registered || stationsChanged))
            {
                _registrar.QueueGuideRefresh();
                result.GuideRefreshQueued = true;
            }

            LastResult = result;
            return result;
        }
        finally
        {
            _lock.Release();
        }
    }

    private async Task StartupSyncAsync(CancellationToken cancellationToken)
    {
        try
        {
            await Task.Delay(StartupDelay, cancellationToken).ConfigureAwait(false);
            for (var attempt = 1; attempt <= StartupAttempts; attempt++)
            {
                var result = await SyncAsync(false, cancellationToken).ConfigureAwait(false);
                if (result.SidecarOk)
                {
                    return;
                }

                await Task.Delay(RetryDelay, cancellationToken).ConfigureAwait(false);
            }

            _logger.LogWarning("Local Broadcast: the sidecar stayed unreachable after startup; save the plugin settings or use Sync now once it is running");
        }
        catch (OperationCanceledException)
        {
        }
    }

    // Local games land in the guide (and the Local Sports channel), which Jellyfin otherwise
    // refreshes once a day: refresh it whenever the upcoming games or their stations change.
    private async Task SportsLoopAsync(CancellationToken cancellationToken)
    {
        try
        {
            await Task.Delay(StartupDelay + TimeSpan.FromMinutes(1), cancellationToken).ConfigureAwait(false);
            while (!cancellationToken.IsCancellationRequested)
            {
                await CheckGamesAsync(cancellationToken).ConfigureAwait(false);
                await Task.Delay(SportsCheckInterval, cancellationToken).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException)
        {
        }
    }

    private async Task CheckGamesAsync(CancellationToken cancellationToken)
    {
        var config = Plugin.Instance?.Configuration;
        if (config is null || !config.SportsEnabled || !config.ManageLiveTv)
        {
            return;
        }

        try
        {
            var sports = await _sidecar.SportsAsync(config, cancellationToken).ConfigureAwait(false);
            var games = GameSignature(sports);
            if (_lastGames is not null && !string.Equals(games, _lastGames, StringComparison.Ordinal))
            {
                _logger.LogInformation("Local Broadcast: local game schedule changed, refreshing the guide");
                _registrar.QueueGuideRefresh();
            }

            _lastGames = games;
        }
        catch (Exception e) when (e is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            _logger.LogDebug("Local Broadcast: sports check failed: {Message}", e.Message);
        }
    }

    /// <summary>
    /// A stable summary of upcoming games (title, start, station), to notice schedule changes.
    /// </summary>
    /// <param name="sports">The sidecar's /api/sports response.</param>
    /// <returns>The signature.</returns>
    internal static string GameSignature(JsonElement sports)
    {
        if (sports.ValueKind != JsonValueKind.Object || !sports.TryGetProperty("upcoming", out var upcoming) || upcoming.ValueKind != JsonValueKind.Array)
        {
            return string.Empty;
        }

        var parts = new List<string>();
        foreach (var g in upcoming.EnumerateArray())
        {
            parts.Add(string.Join('|', Prop(g, "title"), Prop(g, "start"), Prop(g, "station")));
        }

        parts.Sort(StringComparer.Ordinal);
        return string.Join('\n', parts);

        static string Prop(JsonElement e, string name) => e.TryGetProperty(name, out var v) ? v.ToString() : string.Empty;
    }

    private void OnConfigurationChanged(object? sender, BasePluginConfiguration e)
    {
        _ = Task.Run(async () =>
        {
            try
            {
                await SyncAsync(false, _stopping.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Local Broadcast: sync after saving settings failed");
            }
        });
    }

    /// <inheritdoc />
    public void Dispose()
    {
        _stopping.Dispose();
        _lock.Dispose();
        GC.SuppressFinalize(this);
    }
}

/// <summary>
/// Remembers a fingerprint of the stations last pushed to the sidecar, in a file so it survives
/// restarts.
/// </summary>
internal sealed class PushedStationsRecord
{
    private readonly Func<string?> _path;
    private readonly ILogger _logger;
    private string? _last;
    private bool _loaded;

    public PushedStationsRecord(Func<string?> path, ILogger logger)
    {
        _path = path;
        _logger = logger;
    }

    /// <summary>
    /// Records a successful push.
    /// </summary>
    /// <param name="stationsJson">The pushed settings, serialized.</param>
    /// <returns>Whether they differ from the last push, or nothing was recorded yet (first run, or
    /// an older version that didn't record it).</returns>
    public bool Update(string stationsJson)
    {
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(stationsJson)));
        if (!_loaded)
        {
            _last = Read();
            _loaded = true;
        }

        if (string.Equals(_last, hash, StringComparison.Ordinal))
        {
            return false;
        }

        _last = hash;
        Write(hash);
        return true;
    }

    private string? Read()
    {
        try
        {
            return _path() is { } path && File.Exists(path) ? File.ReadAllText(path).Trim() : null;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            _logger.LogDebug("Local Broadcast: could not read the last pushed stations: {Message}", e.Message);
            return null;
        }
    }

    private void Write(string hash)
    {
        try
        {
            if (_path() is { } path)
            {
                Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                File.WriteAllText(path, hash);
            }
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            _logger.LogWarning("Local Broadcast: could not save the last pushed stations: {Message}", e.Message);
        }
    }
}

/// <summary>
/// Outcome of a sync.
/// </summary>
public class SyncResult
{
    /// <summary>
    /// Gets or sets when the sync ran (UTC).
    /// </summary>
    public DateTime Time { get; set; }

    /// <summary>
    /// Gets or sets a value indicating whether the sidecar accepted the station list.
    /// </summary>
    public bool SidecarOk { get; set; }

    /// <summary>
    /// Gets or sets the sidecar error, if any.
    /// </summary>
    public string? SidecarError { get; set; }

    /// <summary>
    /// Gets or sets a value indicating whether the Live TV tuner and guide are in place.
    /// </summary>
    public bool LiveTvOk { get; set; }

    /// <summary>
    /// Gets or sets the Live TV error, if any.
    /// </summary>
    public string? LiveTvError { get; set; }

    /// <summary>
    /// Gets or sets a value indicating whether a guide refresh was queued.
    /// </summary>
    public bool GuideRefreshQueued { get; set; }
}
