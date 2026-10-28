using System;

namespace Jellyfin.Plugin.LocalBroadcast.Configuration;

/// <summary>
/// The coverage radius: which stations are close enough to the home location to appear in Live TV.
/// </summary>
public static class Coverage
{
    private const double EarthRadiusMiles = 3958.8;

    /// <summary>
    /// Great-circle distance between two points.
    /// </summary>
    /// <param name="lat1">First latitude.</param>
    /// <param name="lon1">First longitude.</param>
    /// <param name="lat2">Second latitude.</param>
    /// <param name="lon2">Second longitude.</param>
    /// <returns>The distance in miles.</returns>
    public static double Miles(double lat1, double lon1, double lat2, double lon2)
    {
        static double Rad(double d) => d * Math.PI / 180;
        var dLat = Rad(lat2 - lat1);
        var dLon = Rad(lon2 - lon1);
        var a = (Math.Sin(dLat / 2) * Math.Sin(dLat / 2)) + (Math.Cos(Rad(lat1)) * Math.Cos(Rad(lat2)) * Math.Sin(dLon / 2) * Math.Sin(dLon / 2));
        return 2 * EarthRadiusMiles * Math.Asin(Math.Min(1, Math.Sqrt(a)));
    }

    /// <summary>
    /// Where distances are measured from: the configured home location, else the market's center.
    /// </summary>
    /// <param name="config">The plugin configuration.</param>
    /// <returns>The point, or null if neither is known.</returns>
    public static GeoPoint? Home(PluginConfiguration config)
    {
        if (config.HomeLatitude is { } lat && config.HomeLongitude is { } lon && Valid(lat, lon))
        {
            return new GeoPoint { Latitude = lat, Longitude = lon };
        }

        return Market.Find(config.SelectedMarkets()[0], config)?.Center;
    }

    /// <summary>
    /// The station's distance from the home location.
    /// </summary>
    /// <param name="home">The home location.</param>
    /// <param name="station">The station.</param>
    /// <returns>Miles, or null when either location is unknown.</returns>
    public static double? DistanceMiles(GeoPoint? home, Station station)
        => home is not null && station.Latitude is { } lat && station.Longitude is { } lon && Valid(lat, lon)
            ? Miles(home.Latitude, home.Longitude, lat, lon)
            : null;

    /// <summary>
    /// Whether the station is within the coverage radius (always, with no limit or no location).
    /// </summary>
    /// <param name="config">The plugin configuration.</param>
    /// <param name="home">The home location (<see cref="Home"/>).</param>
    /// <param name="station">The station.</param>
    /// <returns>Whether it's in range.</returns>
    public static bool InRange(PluginConfiguration config, GeoPoint? home, Station station)
        => config.MaxDistanceMiles <= 0 || !(DistanceMiles(home, station) > config.MaxDistanceMiles);

    private static bool Valid(double lat, double lon) => lat is >= -90 and <= 90 && lon is >= -180 and <= 180;
}
