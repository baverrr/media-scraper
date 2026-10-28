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
            // Every bundled station has a location for the coverage area.
            Assert.False(string.IsNullOrWhiteSpace(s.City), s.Id);
            Assert.InRange(s.Latitude!.Value, -90, 90);
            Assert.InRange(s.Longitude!.Value, -180, 180);
        });
        Assert.Equal("Denver, CO", market.Center!.City);
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

public class CoverageTests
{
    private static PluginConfiguration Config(int miles) => new()
    {
        MaxDistanceMiles = miles,
        Stations =
        {
            new Station { Id = "kusa", Url = "https://x", Latitude = 39.7392, Longitude = -104.9903 },
            new Station { Id = "koaa", Url = "https://x", Latitude = 38.2544, Longitude = -104.6091 },
            new Station { Id = "kob", Url = "https://x", Latitude = 35.0844, Longitude = -106.6504 },
            new Station { Id = "custom", Url = "https://x" },
            new Station { Id = "off", Url = "https://x", Enabled = false, Note = "why", Latitude = 35.0844, Longitude = -106.6504 },
        },
    };

    private static JsonElement[] Sent(PluginConfiguration config)
        => JsonDocument.Parse(JsonSerializer.Serialize(SidecarClient.ToSidecarStations(config), SidecarClient.JsonOptions)).RootElement.EnumerateArray().ToArray();

    [Fact]
    public void MeasuresMiles()
    {
        // Denver to Albuquerque is about 333 miles; Denver to Pueblo about 104.
        Assert.InRange(Coverage.Miles(39.7392, -104.9903, 35.0844, -106.6504), 328, 338);
        Assert.InRange(Coverage.Miles(39.7392, -104.9903, 38.2544, -104.6091), 100, 108);
        Assert.Equal(0, Coverage.Miles(1, 2, 1, 2), 6);
    }

    [Fact]
    public void LeavesOutStationsBeyondTheRadiusFromTheMarketCenter()
    {
        var sent = Sent(Config(150));
        Assert.True(sent[0].GetProperty("enabled").GetBoolean());
        Assert.True(sent[1].GetProperty("enabled").GetBoolean());
        Assert.False(sent[2].GetProperty("enabled").GetBoolean());
        Assert.StartsWith("Outside the 150-mile coverage radius (33", sent[2].GetProperty("note").GetString(), StringComparison.Ordinal);
        // No location: always included. Disabled: stays disabled with its own note.
        Assert.True(sent[3].GetProperty("enabled").GetBoolean());
        Assert.Equal("why", sent[4].GetProperty("note").GetString());
    }

    [Fact]
    public void MeasuresFromTheHomeLocationAndZeroMeansNoLimit()
    {
        var config = Config(50);
        config.HomeLatitude = 38.2544;
        config.HomeLongitude = -104.6091;
        var sent = Sent(config);
        Assert.False(sent[0].GetProperty("enabled").GetBoolean());
        Assert.True(sent[1].GetProperty("enabled").GetBoolean());

        Assert.All(Sent(Config(0)).Take(4), s => Assert.True(s.GetProperty("enabled").GetBoolean()));
    }

    [Fact]
    public void FillsInLocationsForStationsSeededBeforeTheyExisted()
    {
        var config = new PluginConfiguration { Stations = { new Station { Id = "koaa" }, new Station { Id = "mine" }, new Station { Id = "kusa", Latitude = 1, Longitude = 2 } } };
        Assert.True(Plugin.AddStationDetails(config, Market.Load("denver")));
        Assert.Equal("Pueblo, CO", config.Stations[0].City);
        Assert.NotNull(config.Stations[0].Latitude);
        Assert.Null(config.Stations[1].Latitude);
        Assert.Equal(1, config.Stations[2].Latitude);
        Assert.False(Plugin.AddStationDetails(config, Market.Load("denver")));
    }

    [Fact]
    public void CombinesMarketsListingEachStationAndTeamOnce()
    {
        var a = Market.Parse("""{"name":"A","timezone":"America/Denver","center":{"city":"A","latitude":1,"longitude":2},"teams":[{"league":"nfl","team":"den","name":"Broncos"}],"stations":[{"id":"one","url":"https://a.example/1"},{"id":"shared","name":"From A","url":"https://a.example/s"}]}""");
        a.Id = "a";
        var b = Market.Parse("""{"name":"B","timezone":"America/Chicago","teams":[{"league":"NFL","team":"DEN","name":"Dup"},{"league":"nba","team":"chi","name":"Bulls"}],"stations":[{"id":"SHARED","name":"From B","url":"https://b.example/s"},{"id":"two","url":"https://b.example/2"}]}""");
        b.Id = "b";
        var m = Market.Combine([a, null, b])!;
        Assert.Equal("a,b", m.Id);
        Assert.Equal("A + B", m.Name);
        Assert.Equal(["one", "shared", "two"], m.Stations.Select(s => s.Id));
        Assert.Equal("From A", m.Stations[1].Name);
        Assert.Equal(["Broncos", "Bulls"], m.Teams.Select(t => t.Name));
        Assert.Equal("America/Denver", m.Timezone);
        Assert.Equal("A", m.Center!.City);
        Assert.Null(Market.Combine([]));
    }

    [Fact]
    public void FindsYourOwnMarketsBeforeBundledOnesAndFallsBackToTheOldSetting()
    {
        var config = new PluginConfiguration { Market = "denver" };
        Assert.Equal(["denver"], config.SelectedMarkets());
        config.CustomMarkets.Add(new CustomMarket { Id = "springfield", Json = """{"name":"Springfield, ST","timezone":"America/Chicago","stations":[{"id":"kxyz","url":"https://kxyz.example/live"}]}""" });
        config.CustomMarkets.Add(new CustomMarket { Id = "broken", Json = "{not json" });
        config.Markets = ["springfield", "denver"];
        var mine = Market.Find("springfield", config)!;
        Assert.True(mine.Custom);
        Assert.Equal("springfield", mine.Id);
        Assert.Null(Market.Find("broken", config));
        Assert.False(Market.Find("denver", config)!.Custom);
        var selected = Market.Selected(config)!;
        Assert.Equal("kxyz", selected.Stations[0].Id);
        Assert.True(selected.Stations.Count > 20);
        Assert.Equal("America/Chicago", JsonSerializer.SerializeToElement(SidecarClient.ToSidecarSports(config), SidecarClient.JsonOptions).GetProperty("timezone").GetString());
        Assert.StartsWith("{", Market.FileJson("denver", config));
        Assert.Contains("kxyz", Market.FileJson("springfield", config));
    }

    [Fact]
    public void ExplainsMarketFileJsonProblemsInPlainWords()
    {
        // Valid JSON in the wrong layout names the field and what belongs there, not .NET types.
        var stations = MarketFile.Check("""{"name":"broken","stations":"nope"}""", out _)!;
        Assert.Equal("\"stations\" should be a list in [ ] (line 1, column 35).", stations);
        Assert.DoesNotContain("System.", stations);
        Assert.DoesNotContain("valid JSON", stations);
        Assert.Equal("\"name\" should be text in quotes (line 1, column 10).", MarketFile.Check("""{"name":5,"stations":[]}""", out _));
        Assert.StartsWith("\"stations[0]\" should be an object in { }", MarketFile.Check("""{"name":"X","stations":["a"]}""", out _));
        Assert.StartsWith("The market file should be an object in { }", MarketFile.Check("[]", out _));

        // Broken JSON says where, without the serializer's "Path: $ | LineNumber" tail.
        var syntax = MarketFile.Check("{\n  \"name\": \"X\",,\n}", out _)!;
        Assert.StartsWith("The market file isn't valid JSON (line 2, column ", syntax);
        Assert.DoesNotContain("LineNumber", syntax);
        Assert.DoesNotContain("Path:", syntax);
    }

    [Fact]
    public void ChecksMarketFilesAndPicksUniqueIds()
    {
        Assert.Contains("empty", MarketFile.Check("", out _));
        Assert.Contains("valid JSON", MarketFile.Check("{nope", out _));
        Assert.Contains("\"name\"", MarketFile.Check("""{"stations":[{"id":"a","url":"https://a.example/"}]}""", out _));
        Assert.Contains("no stations", MarketFile.Check("""{"name":"X","stations":[]}""", out _));
        Assert.Contains("isn't valid", MarketFile.Check("""{"name":"X","stations":[{"id":"Bad Id","url":"https://a.example/"}]}""", out _));
        Assert.Contains("twice", MarketFile.Check("""{"name":"X","stations":[{"id":"a","url":"https://a.example/"},{"id":"a","url":"https://a.example/2"}]}""", out _));
        Assert.Contains("http(s)", MarketFile.Check("""{"name":"X","stations":[{"id":"a","url":"javascript:alert(1)"}]}""", out _));
        Assert.Null(MarketFile.Check("""{"name":"Springfield, ST","stations":[{"id":"a","url":"https://a.example/"}]}""", out var ok));
        Assert.Equal("Springfield, ST", ok!.Name);

        const string Ok = """{"name":"X","stations":[{"id":"a","url":"https://a.example/"}]}""";
        Assert.Null(MarketFile.Check(Ok, out _));
        Assert.Contains("streamUrl", MarketFile.Check("""{"name":"X","stations":[{"id":"a","url":"https://a.example/","streamUrl":"ftp://x"}]}""", out _));
        Assert.Contains("HH:MM", MarketFile.Check("""{"name":"X","stations":[{"id":"a","url":"https://a.example/","schedule":[{"days":"daily","start":"6:00","end":"07:00"}]}]}""", out _));
        Assert.Contains("days", MarketFile.Check("""{"name":"X","stations":[{"id":"a","url":"https://a.example/","schedule":[{"days":["someday"],"start":"06:00","end":"07:00"}]}]}""", out _));
        Assert.Null(MarketFile.Check("""{"name":"X","stations":[{"id":"a","url":"https://a.example/","schedule":[{"days":["Monday","sat"],"start":"06:00","end":"07:00"}]}]}""", out _));
        Assert.Contains("unknown league", MarketFile.Check("""{"name":"X","teams":[{"league":"cricket","team":"x","name":"Y"}],"stations":[{"id":"a","url":"https://a.example/"}]}""", out _));
        Assert.Contains("ESPN team", MarketFile.Check("""{"name":"X","teams":[{"league":"nfl","team":"../x","name":"Y"}],"stations":[{"id":"a","url":"https://a.example/"}]}""", out _));
        Assert.Contains("can't be saved", MarketFile.Check("{\"name\":\"X\uFFFF\",\"stations\":[{\"id\":\"a\",\"url\":\"https://a.example/\"}]}", out _));

        var config = new PluginConfiguration();
        Assert.Equal("springfield-st", MarketFile.NewId("Springfield, ST", config));
        Assert.Equal("denver-2", MarketFile.NewId("Denver", config));
        config.CustomMarkets.Add(new CustomMarket { Id = "springfield-st" });
        Assert.Equal("springfield-st-2", MarketFile.NewId("Springfield, ST", config));
        Assert.Equal("combined-2", MarketFile.NewId("Combined", config));
        Assert.Equal("market", MarketFile.NewId("!!!", config));
    }

    [Fact]
    public void KeepsYourMarketsThroughJellyfinsXmlSettings()
    {
        var config = new PluginConfiguration { Markets = ["mine", "denver"], HiddenMarkets = ["other"] };
        config.CustomMarkets.Add(new CustomMarket { Id = "mine", Json = "{\n  \"name\": \"Mine <& \\\"quoted\\\">\",\n  \"stations\": []\n}\n" });
        config.Stations.Add(new Station { Id = "koat", Schedule = { new NewscastBlock { Days = { "mon", "tue" }, Start = "17:00", End = "17:30", Title = "News" } } });
        var xml = new System.Xml.Serialization.XmlSerializer(typeof(PluginConfiguration));
        using var buffer = new System.IO.MemoryStream();
        xml.Serialize(buffer, config);
        buffer.Position = 0;
        var back = (PluginConfiguration)xml.Deserialize(buffer)!;
        Assert.Equal(["mine", "denver"], back.Markets);
        Assert.Equal(["other"], back.HiddenMarkets);
        Assert.Equal(config.CustomMarkets[0].Json, back.CustomMarkets[0].Json);
        Assert.Single(back.Stations[0].Schedule);
        Assert.Equal(["mon", "tue"], back.Stations[0].Schedule[0].Days);
    }

    [Fact]
    public void ReadsNewscastDaysAsAListOrACommaSeparatedString()
    {
        var market = Market.Parse("""{"name":"T","stations":[{"id":"a","url":"https://a.example/","schedule":[{"days":"weekdays","start":"17:00","end":"17:30","title":"News"},{"days":["sat","sun"],"start":"18:00","end":"18:30","title":"Weekend"}]}]}""");
        Assert.Equal(["weekdays"], market.Stations[0].Schedule[0].Days);
        Assert.Equal(["sat", "sun"], market.Stations[0].Schedule[1].Days);
    }

    [Fact]
    public void FillsInLogosAndNewscastsButKeepsYourOwn()
    {
        var mine = new NewscastBlock { Days = { "mon" }, Start = "09:00", End = "09:30", Title = "Mine" };
        var config = new PluginConfiguration
        {
            Stations =
            {
                new Station { Id = "koat", Latitude = 1, Longitude = 2 },
                new Station { Id = "kgwn", Latitude = 1, Longitude = 2, Logo = "https://logo.example/kgwn.png", Schedule = { mine } },
            },
        };
        Assert.True(Plugin.AddStationDetails(config, Market.Load("denver")));
        Assert.StartsWith("https://", config.Stations[0].Logo);
        Assert.Contains(config.Stations[0].Schedule, b => b.Title == "KOAT Action 7 News at 5pm" && b.Start == "17:00" && b.Days.Contains("sat"));
        Assert.Equal("https://logo.example/kgwn.png", config.Stations[1].Logo);
        Assert.Equal([mine], config.Stations[1].Schedule);
        Assert.False(Plugin.AddStationDetails(config, Market.Load("denver")));

        var sent = JsonSerializer.SerializeToElement(SidecarClient.ToSidecarStations(config), SidecarClient.JsonOptions);
        Assert.Equal("17:00", sent[0].GetProperty("schedule").EnumerateArray().First(b => b.GetProperty("title").GetString() == "KOAT Action 7 News at 5pm").GetProperty("start").GetString());
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
            SidecarClient.ToSidecarStations(new PluginConfiguration { Stations = { new Station { Id = " KUSA ", CallSign = "KUSA", Name = "9NEWS", Url = "https://x", Logo = " " } } }),
            SidecarClient.JsonOptions);
        Assert.Equal("""[{"id":"kusa","callSign":"KUSA","name":"9NEWS","channel":"","network":"","url":"https://x","streamUrl":null,"signInUrl":null,"signUpUrl":null,"logo":null,"sportsAliases":[],"keepReady":false,"schedule":[],"note":null,"enabled":true}]""", json);
    }

    [Fact]
    public void SendsSportsAliasesAsAListAndTeamsNormalized()
    {
        var stations = JsonSerializer.Serialize(
            SidecarClient.ToSidecarStations(new PluginConfiguration { Stations = { new Station { Id = "ktvd", Url = "https://x", SportsAliases = " Altitude Sports, ,Altitude " } } }),
            SidecarClient.JsonOptions);
        Assert.Contains("\"sportsAliases\":[\"Altitude Sports\",\"Altitude\"]", stations, StringComparison.Ordinal);

        var config = new PluginConfiguration { SportsEnabled = true, SportsChannel = " ", Teams = { new SportsTeam { League = " NFL ", Team = " den ", Name = "Broncos" } } };
        Assert.Equal("""{"enabled":true,"channel":"1.1","teams":[{"league":"nfl","team":"den","name":"Broncos"}],"timezone":"America/Denver"}""", JsonSerializer.Serialize(SidecarClient.ToSidecarSports(config), SidecarClient.JsonOptions));
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

    [Fact]
    public void PushedStationsRecordSurvivesRestarts()
    {
        var dir = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "lb-test-" + Guid.NewGuid().ToString("N"));
        var path = System.IO.Path.Combine(dir, "last-pushed-stations.txt");
        var logger = Microsoft.Extensions.Logging.Abstractions.NullLogger.Instance;
        try
        {
            var run1 = new PushedStationsRecord(() => path, logger);
            Assert.True(run1.Update("a"));  // nothing recorded yet
            Assert.False(run1.Update("a"));
            Assert.True(run1.Update("b"));

            // After a restart: unchanged stations aren't a change, stations changed while down are.
            Assert.False(new PushedStationsRecord(() => path, logger).Update("b"));
            Assert.True(new PushedStationsRecord(() => path, logger).Update("c"));

            // No data folder: still tracks changes within the run.
            var noFile = new PushedStationsRecord(() => null, logger);
            Assert.True(noFile.Update("a"));
            Assert.False(noFile.Update("a"));
        }
        finally
        {
            if (System.IO.Directory.Exists(dir))
            {
                System.IO.Directory.Delete(dir, true);
            }
        }
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
