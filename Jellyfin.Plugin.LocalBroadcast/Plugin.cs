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
            SaveConfiguration();
        }
        else if (AddStationLocations(Configuration, Market.Load(Configuration.Market)))
        {
            SaveConfiguration();
        }
    }

    /// <summary>
    /// Fills in the city and coordinates of stations seeded before market files had them, from
    /// the bundled market's station with the same id.
    /// </summary>
    /// <param name="config">The plugin configuration.</param>
    /// <param name="market">The bundled market.</param>
    /// <returns>Whether anything changed.</returns>
    internal static bool AddStationLocations(PluginConfiguration config, Market? market)
    {
        var changed = false;
        foreach (var s in config.Stations)
        {
            if (s.Latitude is not null || market?.Stations.Find(m => string.Equals(m.Id, s.Id, StringComparison.OrdinalIgnoreCase)) is not { Latitude: not null } m)
            {
                continue;
            }

            s.City ??= m.City;
            s.Latitude = m.Latitude;
            s.Longitude = m.Longitude;
            changed = true;
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
