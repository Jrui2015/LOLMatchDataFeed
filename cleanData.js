var fs = require("fs");
var championStream = fs.createWriteStream("./clean_data/champion.txt", {
  "flags": "a"
});
var teamStream = fs.createWriteStream("./clean_data/team.txt", {
  "flags": "a"
});
var config = require('./config.json');
var es = require('elasticsearch').Client({
  hosts: config.host,
  connectionClass: require('http-aws-es'),
  amazonES: {
    region: 'us-west-2',
    accessKey: config.accessKeyId,
    secretKey: config.secretAccessKey
  }
});

var globalCount = 0;

es.search({
  index: 'loldata',
  type: 'matchData',
  scroll: '10s', // keep the search results "scrollable" for 10 seconds
  size: 1000,
  body: {
    "query": {
      "match_all": {}
    }
  }
}, function getMoreUntilDone(error, response) {
  // collect the title from each response
  response.hits.hits.forEach(function(hit) {

    globalCount++;

    // 1. champion.txt
    var championData = hit._source.participants;
    championData.forEach(function(chmp) {
      (function(championName, winner, lane, kills, kda, quadraKills, pentaKills, firstBloodKill) {
        var result = (winner === true ? "win" : "lose");
        championStream.write(championName + "\t" + result + "\t" + lane + "\t" + kills + "\t" + kda + "\t" + quadraKills + "\t" + pentaKills + "\t" + firstBloodKill + "\n");
      })(chmp.name, chmp.winner, chmp.lane, chmp.kills, chmp.kda, chmp.quadraKills, chmp.pentaKills, chmp.firstBlood);
    });

    // 2. team.txt
    var teamData = hit._source.teams;
    teamData.forEach(function(t) {
      (function(teamId, winner, firstBlood, firstTower, firstInhibitor, firstBaron, dragonKills, baronKills, banArray) {
        var result = (winner === true ? "win" : "lose");
        var line = teamId + "\t" + result + "\t" + firstBlood + "\t" + firstTower + "\t" + firstInhibitor + "\t" + firstBaron + "\t" + dragonKills + "\t" + baronKills;

        if (banArray.length !== 0) {
          banArray.forEach(function(b) {
            line += "\t" + b.name;
          });
        }

        teamStream.write(line + "\n");
      })(t.teamId, t.winner, t.firstBlood, t.firstTower, t.firstInhibitor, t.firstBaron, t.dragonKills, t.baronKills, t.bans);
    });

  });

  if (response.hits.total !== globalCount) {
    // ask elasticsearch for the next set of hits from this search
    es.scroll({
      scrollId: response._scroll_id,
      scroll: '10s'
    }, getMoreUntilDone);

    console.log(globalCount);
  } else {
    console.log("2 input file ready!");
  }
});