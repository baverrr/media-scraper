using System;
using System.Linq;
using System.Threading.Tasks;
using Jellyfin.Plugin.LocalBroadcast.Configuration;
using Jellyfin.Plugin.LocalBroadcast.Sidecar;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.LiveTv;
using MediaBrowser.Model.LiveTv;
using MediaBrowser.Model.Tasks;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.LocalBroadcast.LiveTv;

/// <summary>
/// Keeps one M3U tuner (the sidecar's playlist) and one XMLTV guide (the sidecar's guide) in
/// Jellyfin's Live TV settings. Entries are found again by name and URL, so the plugin keeps no
/// ids of its own and a changed sidecar URL updates the existing entries instead of adding more.
/// </summary>
public class LiveTvRegistrar
{
    /// <summary>
    /// The tuner's friendly name in Jellyfin's Live TV settings.
    /// </summary>
    public const string TunerName = "Local Broadcast";

    private readonly ITunerHostManager _tunerHosts;
    private readonly IListingsManager _listings;
    private readonly IConfigurationManager _configurationManager;
    private readonly ITaskManager _taskManager;
    private readonly ILogger<LiveTvRegistrar> _logger;

    public LiveTvRegistrar(
        ITunerHostManager tunerHosts,
        IListingsManager listings,
        IConfigurationManager configurationManager,
        ITaskManager taskManager,
        ILogger<LiveTvRegistrar> logger)
    {
        _tunerHosts = tunerHosts;
        _listings = listings;
        _configurationManager = configurationManager;
        _taskManager = taskManager;
        _logger = logger;
    }

    /// <summary>
    /// Finds the plugin's tuner among the configured ones: by name first, then by playlist URL.
    /// </summary>
    /// <param name="tuners">Configured tuners.</param>
    /// <param name="playlistUrl">The sidecar playlist URL.</param>
    /// <returns>The tuner, or null.</returns>
    internal static TunerHostInfo? FindTuner(TunerHostInfo[]? tuners, string playlistUrl)
        => (tuners ?? []).FirstOrDefault(t => IsM3u(t) && string.Equals(t.FriendlyName, TunerName, StringComparison.Ordinal))
           ?? (tuners ?? []).FirstOrDefault(t => IsM3u(t) && string.Equals(t.Url, playlistUrl, StringComparison.OrdinalIgnoreCase));

    /// <summary>
    /// Finds the plugin's guide: the XMLTV provider bound to its tuner, else one with the guide URL.
    /// </summary>
    /// <param name="providers">Configured listings providers.</param>
    /// <param name="tunerId">The plugin tuner's id.</param>
    /// <param name="guideUrl">The sidecar guide URL.</param>
    /// <returns>The provider, or null.</returns>
    internal static ListingsProviderInfo? FindListings(ListingsProviderInfo[]? providers, string tunerId, string guideUrl)
        => (providers ?? []).FirstOrDefault(p => IsXmlTv(p) && !p.EnableAllTuners && (p.EnabledTuners ?? []).Length == 1 && p.EnabledTuners![0] == tunerId)
           ?? (providers ?? []).FirstOrDefault(p => IsXmlTv(p) && string.Equals(p.Path, guideUrl, StringComparison.OrdinalIgnoreCase));

    /// <summary>
    /// Adds or updates the tuner and guide entries.
    /// </summary>
    /// <param name="config">The plugin configuration.</param>
    /// <returns>True when anything was added or changed.</returns>
    public async Task<bool> EnsureAsync(PluginConfiguration config)
    {
        var playlistUrl = SidecarClient.UrlFor(config, "/playlist.m3u");
        var guideUrl = SidecarClient.UrlFor(config, "/guide.xml");
        var options = _configurationManager.GetConfiguration<LiveTvOptions>("livetv");
        var changed = false;

        var tuner = FindTuner(options.TunerHosts, playlistUrl);
        if (tuner is null)
        {
            tuner = await _tunerHosts.SaveTunerHost(
                new TunerHostInfo
                {
                    Type = "m3u",
                    Url = playlistUrl,
                    FriendlyName = TunerName,
                    TunerCount = 0, // no limit: each station is a separate web stream
                    AllowHWTranscoding = true,
                    AllowStreamSharing = true,
                    IgnoreDts = true,
                    ImportFavoritesOnly = false,
                },
                true).ConfigureAwait(false);
            _logger.LogInformation("Added Live TV tuner {Name} for {Url}", TunerName, playlistUrl);
            changed = true;
        }
        else if (!string.Equals(tuner.Url, playlistUrl, StringComparison.Ordinal) || !string.Equals(tuner.FriendlyName, TunerName, StringComparison.Ordinal))
        {
            tuner.Url = playlistUrl;
            tuner.FriendlyName = TunerName;
            tuner = await _tunerHosts.SaveTunerHost(tuner, true).ConfigureAwait(false);
            _logger.LogInformation("Updated Live TV tuner {Name} to {Url}", TunerName, playlistUrl);
            changed = true;
        }

        options = _configurationManager.GetConfiguration<LiveTvOptions>("livetv");
        var listings = FindListings(options.ListingProviders, tuner.Id, guideUrl);
        if (listings is null
            || !string.Equals(listings.Path, guideUrl, StringComparison.Ordinal)
            || listings.EnableAllTuners
            || (listings.EnabledTuners ?? []).Length != 1
            || listings.EnabledTuners![0] != tuner.Id)
        {
            listings ??= new ListingsProviderInfo { Type = "xmltv" };
            listings.Path = guideUrl;
            listings.EnableAllTuners = false;
            listings.EnabledTuners = [tuner.Id];
            // No validation: the sidecar may still be starting, and the guide refreshes later anyway.
            await _listings.SaveListingProvider(listings, false, false).ConfigureAwait(false);
            _logger.LogInformation("Set Live TV guide for {Name} to {Url}", TunerName, guideUrl);
            changed = true;
        }

        return changed;
    }

    /// <summary>
    /// Queues Jellyfin's guide refresh so channel and program changes show up now instead of at
    /// the next scheduled run.
    /// </summary>
    public void QueueGuideRefresh()
    {
        var task = _taskManager.ScheduledTasks.FirstOrDefault(t => string.Equals(t.ScheduledTask.Key, "RefreshGuide", StringComparison.Ordinal));
        if (task is null)
        {
            _logger.LogWarning("Jellyfin's guide refresh task was not found");
            return;
        }

        _taskManager.QueueScheduledTask(task.ScheduledTask, new TaskOptions());
    }

    private static bool IsM3u(TunerHostInfo t) => string.Equals(t.Type, "m3u", StringComparison.OrdinalIgnoreCase);

    private static bool IsXmlTv(ListingsProviderInfo p) => string.Equals(p.Type, "xmltv", StringComparison.OrdinalIgnoreCase);
}
