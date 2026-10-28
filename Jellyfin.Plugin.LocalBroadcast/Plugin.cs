using System;
using System.Collections.Generic;
using System.Globalization;
using Jellyfin.Plugin.LocalBroadcast.Configuration;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;

namespace Jellyfin.Plugin.LocalBroadcast;

/// <summary>
/// Local Broadcast plugin: local TV stations' website live streams as a Live TV tuner, through the
/// local-broadcast sidecar.
/// </summary>
public class Plugin : BasePlugin<PluginConfiguration>, IHasWebPages
{
    public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
        : base(applicationPaths, xmlSerializer)
    {
        Instance = this;

        // Seed the market defaults here rather than in the configuration's initializer: the XML serializer
        // adds deserialized items to an initialized collection, which would duplicate them.
        if (!Configuration.StationsSeeded)
        {
            var market = Market.Load(Configuration.Market) ?? Market.Load("denver");
            if (market is not null)
            {
                if (Configuration.Stations.Count == 0)
                {
                    market.Stations.ForEach(Configuration.Stations.Add);
                }

                if (Configuration.Teams.Count == 0)
                {
                    market.Teams.ForEach(Configuration.Teams.Add);
                }

                Configuration.SportsChannel = market.SportsChannel ?? Configuration.SportsChannel;
            }

            Configuration.StationsSeeded = true;
            Configuration.StationDetailsVersion = StationDetailsVersion; // seeded with them already
            SaveConfiguration();
        }
        else if (Configuration.StationDetailsVersion < StationDetailsVersion)
        {
            // Once per new kind of market detail; anything already set is kept.
            AddStationDetails(Configuration, Market.Load(Configuration.Market));
            Configuration.StationDetailsVersion = StationDetailsVersion;
            SaveConfiguration();
        }
    }

    /// <summary>
    /// Which market details <see cref="AddStationDetails"/> fills in: 1 = locations, logos and
    /// newscast times. Raise it when it learns another.
    /// </summary>
    internal const int StationDetailsVersion = 1;

    /// <summary>
    /// Fills in what market files gained after a station was set up, from the bundled market's
    /// station with the same id: its city and coordinates, logo and newscast schedule. Anything
    /// already set is kept.
    /// </summary>
    /// <param name="config">The plugin configuration.</param>
    /// <param name="market">The bundled market.</param>
    /// <returns>Whether anything changed.</returns>
    internal static bool AddStationDetails(PluginConfiguration config, Market? market)
    {
        var changed = false;
        foreach (var s in config.Stations)
        {
            if (market?.Stations.Find(m => string.Equals(m.Id, s.Id, StringComparison.OrdinalIgnoreCase)) is not { } m)
            {
                continue;
            }

            if (s.Latitude is null && m.Latitude is not null)
            {
                s.City ??= m.City;
                s.Latitude = m.Latitude;
                s.Longitude = m.Longitude;
                changed = true;
            }

            if (string.IsNullOrWhiteSpace(s.Logo) && !string.IsNullOrWhiteSpace(m.Logo))
            {
                s.Logo = m.Logo;
                changed = true;
            }

            if (s.Schedule.Count == 0 && m.Schedule.Count > 0)
            {
                s.Schedule = m.Schedule;
                changed = true;
            }
        }

        return changed;
    }

    /// <inheritdoc />
    public override string Name => "Local Broadcast";

    /// <inheritdoc />
    public override Guid Id => Guid.Parse("d0766040-c26a-4cc7-9c0b-c7064aa77001");

    /// <inheritdoc />
    public override string Description => "Local TV stations' live streams in Live TV, found on the stations' websites.";

    /// <summary>
    /// Gets the current plugin instance.
    /// </summary>
    public static Plugin? Instance { get; private set; }

    /// <inheritdoc />
    public IEnumerable<PluginPageInfo> GetPages()
    {
        return
        [
            new PluginPageInfo
            {
                Name = Name,
                EmbeddedResourcePath = string.Format(CultureInfo.InvariantCulture, "{0}.Configuration.configPage.html", GetType().Namespace)
            }
        ];
    }
}
