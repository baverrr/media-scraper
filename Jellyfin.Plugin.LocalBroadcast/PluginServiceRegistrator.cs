using Jellyfin.Plugin.LocalBroadcast.LiveTv;
using Jellyfin.Plugin.LocalBroadcast.Sidecar;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Plugins;
using Microsoft.Extensions.DependencyInjection;

namespace Jellyfin.Plugin.LocalBroadcast;

/// <summary>
/// Registers plugin services.
/// </summary>
public class PluginServiceRegistrator : IPluginServiceRegistrator
{
    /// <inheritdoc />
    public void RegisterServices(IServiceCollection serviceCollection, IServerApplicationHost applicationHost)
    {
        serviceCollection.AddSingleton<SidecarClient>();
        serviceCollection.AddSingleton<LiveTvRegistrar>();
        serviceCollection.AddSingleton<SyncService>();
        // The same instance is the hosted service, so the controller sees its last result.
        serviceCollection.AddHostedService(sp => sp.GetRequiredService<SyncService>());
    }
}
