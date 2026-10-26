using System;
using System.Linq;
using System.Text.Json;
using Jellyfin.Plugin.LocalBroadcast.Configuration;
using Jellyfin.Plugin.LocalBroadcast.LiveTv;
using Jellyfin.Plugin.LocalBroadcast.Sidecar;
using MediaBrowser.Model.LiveTv;
using Xunit;

namespace Jellyfin.Plugin.LocalBroadcast.Tests;

public class MarketTests
{
    [Fact]
    public void DenverIsBundledWithAtLeastFifteenStationsAndLocalTeams()
    {
        Assert.Contains("denver", Market.Ids());
        var market = Market.Load("denver")!;
        Assert.Equal("Denver, CO", market.Name);
        Assert.True(market.Stations.Count >= 15);
        Assert.Equal(market.Stations.Count, market.Stations.Select(s => s.Id).Distinct().Count());
        Assert.All(market.Stations, s =>
        {
            Assert.Matches("^[a-z0-9][a-z0-9_-]*$", s.Id);
            Assert.False(string.IsNullOrWhiteSpace(s.Name));
            Assert.StartsWith("https://", s.Url);
            // Every disabled station says why.
            Assert.True(s.Enabled || !string.IsNullOrWhiteSpace(s.Note), s.Id);
        });
        Assert.Contains(market.Stations, s => s.CallSign == "KUSA" && s.Channel == "9.1" && s.Enabled);
        Assert.Contains(market.Teams, t => t.League == "nfl" && t.Team == "den");
        Assert.Null(Market.Load("nowhere"));
    }

    [Fact]
    public void ParsesTheMarketFileFormat()
    {
        var market = Market.Parse("""{"name":"X","sportsChannel":"2.9","teams":[{"league":"nba","team":"den","name":"Nuggets"},{"league":"","team":"x"}],"stations":[{"id":"ktvd","callSign":"KTVD","url":"https://x","enabled":false,"note":"why","sportsAliases":["Altitude Sports","Altitude"]},{"name":"no id"}]}""");
        Assert.Equal("2.9", market.SportsChannel);
        var team = Assert.Single(market.Teams);
        Assert.Equal("Nuggets", team.Name);
        var s = Assert.Single(market.Stations);
        Assert.False(s.Enabled);
        Assert.Equal("why", s.Note);
        Assert.Equal("Altitude Sports, Altitude", s.SportsAliases);
    }
}

public class SidecarClientTests
{
    [Fact]
    public void BuildsUrlsFromTheConfiguredBase()
    {
        var config = new PluginConfiguration { SidecarUrl = " http://127.0.0.1:8899/ " };
        Assert.Equal("http://127.0.0.1:8899/playlist.m3u", SidecarClient.UrlFor(config, "/playlist.m3u"));
    }

    [Fact]
    public void SendsStationsInTheSidecarsShape()
    {
        var json = JsonSerializer.Serialize(
            SidecarClient.ToSidecarStations([new Station { Id = " KUSA ", CallSign = "KUSA", Name = "9NEWS", Url = "https://x", Logo = " " }]),
            SidecarClient.JsonOptions);
        Assert.Equal("""[{"id":"kusa","callSign":"KUSA","name":"9NEWS","channel":"","network":"","url":"https://x","streamUrl":null,"logo":null,"sportsAliases":[],"note":null,"enabled":true}]""", json);
    }

    [Fact]
    public void SendsSportsAliasesAsAListAndTeamsNormalized()
    {
        var stations = JsonSerializer.Serialize(
            SidecarClient.ToSidecarStations([new Station { Id = "ktvd", Url = "https://x", SportsAliases = " Altitude Sports, ,Altitude " }]),
            SidecarClient.JsonOptions);
        Assert.Contains("\"sportsAliases\":[\"Altitude Sports\",\"Altitude\"]", stations, StringComparison.Ordinal);

        var config = new PluginConfiguration { SportsEnabled = true, SportsChannel = " ", Teams = { new SportsTeam { League = " NFL ", Team = " den ", Name = "Broncos" } } };
        Assert.Equal("""{"enabled":true,"channel":"1.1","teams":[{"league":"nfl","team":"den","name":"Broncos"}]}""", JsonSerializer.Serialize(SidecarClient.ToSidecarSports(config), SidecarClient.JsonOptions));
    }

    [Fact]
    public void GameSignatureIgnoresOrderAndNoise()
    {
        static JsonElement Parse(string json) => JsonDocument.Parse(json).RootElement;
        var a = SyncService.GameSignature(Parse("""{"upcoming":[{"title":"A","start":"1","station":"kcnc","state":"pre"},{"title":"B","start":"2","station":"kusa"}]}"""));
        var b = SyncService.GameSignature(Parse("""{"upcoming":[{"title":"B","start":"2","station":"kusa"},{"title":"A","start":"1","station":"kcnc","state":"in"}]}"""));
        Assert.Equal(a, b);
        Assert.NotEqual(a, SyncService.GameSignature(Parse("""{"upcoming":[{"title":"A","start":"1","station":"kdvr"}]}""")));
        Assert.Equal(string.Empty, SyncService.GameSignature(Parse("""{"error":"x"}""")));
    }
}

public class LiveTvRegistrarTests
{
    private const string Playlist = "http://127.0.0.1:8899/playlist.m3u";
    private const string Guide = "http://127.0.0.1:8899/guide.xml";

    [Fact]
    public void FindsItsTunerByNameEvenAfterTheUrlChanged()
    {
        var tuners = new[]
        {
            new TunerHostInfo { Id = "hdhr", Type = "hdhomerun", FriendlyName = "Local Broadcast", Url = "http://hdhr" },
            new TunerHostInfo { Id = "other", Type = "m3u", FriendlyName = "IPTV", Url = "http://iptv/list.m3u" },
            new TunerHostInfo { Id = "ours", Type = "m3u", FriendlyName = "Local Broadcast", Url = "http://old-host:8899/playlist.m3u" },
        };
        Assert.Equal("ours", LiveTvRegistrar.FindTuner(tuners, Playlist)?.Id);
    }

    [Fact]
    public void FallsBackToTheTunerWithThePlaylistUrl()
    {
        var tuners = new[] { new TunerHostInfo { Id = "renamed", Type = "m3u", FriendlyName = "My locals", Url = Playlist } };
        Assert.Equal("renamed", LiveTvRegistrar.FindTuner(tuners, Playlist)?.Id);
        Assert.Null(LiveTvRegistrar.FindTuner(null, Playlist));
    }

    [Fact]
    public void FindsItsGuideByTunerBindingThenByUrl()
    {
        var providers = new[]
        {
            new ListingsProviderInfo { Id = "sd", Type = "schedulesdirect", EnabledTuners = ["ours"] },
            new ListingsProviderInfo { Id = "all", Type = "xmltv", Path = "http://epg/all.xml", EnableAllTuners = true },
            // EnableAllTuners defaults to true in Jellyfin; the plugin's entry sets it false.
            new ListingsProviderInfo { Id = "ours", Type = "xmltv", Path = "http://old-host:8899/guide.xml", EnabledTuners = ["ours"], EnableAllTuners = false },
        };
        Assert.Equal("ours", LiveTvRegistrar.FindListings(providers, "ours", Guide)?.Id);
        Assert.Null(LiveTvRegistrar.FindListings(providers, "nope", Guide));

        var byUrl = new[] { new ListingsProviderInfo { Id = "x", Type = "xmltv", Path = Guide, EnableAllTuners = true } };
        Assert.Equal("x", LiveTvRegistrar.FindListings(byUrl, "ours", Guide)?.Id);
    }
}

public class SidecarClientAuthTests
{
    private sealed class Capture : System.Net.Http.HttpMessageHandler
    {
        public string? ApiKey { get; private set; }

        protected override System.Threading.Tasks.Task<System.Net.Http.HttpResponseMessage> SendAsync(System.Net.Http.HttpRequestMessage request, System.Threading.CancellationToken cancellationToken)
        {
            ApiKey = request.Headers.TryGetValues("X-Api-Key", out var v) ? v.Single() : null;
            return System.Threading.Tasks.Task.FromResult(new System.Net.Http.HttpResponseMessage(System.Net.HttpStatusCode.OK) { Content = new System.Net.Http.StringContent("[]") });
        }
    }

    private sealed class Factory(System.Net.Http.HttpMessageHandler handler) : System.Net.Http.IHttpClientFactory
    {
        public System.Net.Http.HttpClient CreateClient(string name) => new(handler, false);
    }

    [Fact]
    public async System.Threading.Tasks.Task SendsTheApiKeyTrimmed()
    {
        var capture = new Capture();
        var client = new SidecarClient(new Factory(capture));
        await client.StatusAsync(new PluginConfiguration { SidecarUrl = "http://sidecar:8899", ApiKey = " secret\n" }, System.Threading.CancellationToken.None);
        Assert.Equal("secret", capture.ApiKey);
    }

    [Theory]
    [InlineData("localhost:8899")]
    [InlineData("")]
    [InlineData("ftp://sidecar")]
    public async System.Threading.Tasks.Task RejectsASidecarUrlThatIsNotAFullHttpAddress(string url)
    {
        var client = new SidecarClient(new Factory(new Capture()));
        var e = await Assert.ThrowsAsync<System.Net.Http.HttpRequestException>(() => client.StatusAsync(new PluginConfiguration { SidecarUrl = url }, System.Threading.CancellationToken.None));
        Assert.Contains("http://127.0.0.1:8899", e.Message);
    }

    private sealed class Html : System.Net.Http.HttpMessageHandler
    {
        protected override System.Threading.Tasks.Task<System.Net.Http.HttpResponseMessage> SendAsync(System.Net.Http.HttpRequestMessage request, System.Threading.CancellationToken cancellationToken)
            => System.Threading.Tasks.Task.FromResult(new System.Net.Http.HttpResponseMessage(System.Net.HttpStatusCode.OK) { Content = new System.Net.Http.StringContent("<html>login</html>") });
    }

    [Fact]
    public async System.Threading.Tasks.Task ReportsANonJsonAnswerAsAnHttpError()
    {
        var client = new SidecarClient(new Factory(new Html()));
        var e = await Assert.ThrowsAsync<System.Net.Http.HttpRequestException>(() => client.StatusAsync(new PluginConfiguration { SidecarUrl = "http://wrong:80" }, System.Threading.CancellationToken.None));
        Assert.Contains("not JSON", e.Message);
    }
}
