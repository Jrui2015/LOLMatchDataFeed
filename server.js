var queueModule = require('queue-fifo');
var LolApi = require('leagueapi');
var Elasticsearch = require('aws-es');
var config = require('./config.json');
var championList = require('./championList.json');
var epoch = require('epoch.js');

// LOLApi config
LolApi.init(config.lolKey, 'na');
LolApi.setRateLimit(10, 500);
// AWS ES config
var Elasticsearch = require('aws-es');
var elasticsearch = new Elasticsearch({
  accessKeyId: config.accessKeyId,
  secretAccessKey: config.secretAccessKey,
  service: 'es',
  region: "us-west-2",
  host: config.host
});
// queue config
var queue = new queueModule();
queue.enqueue(2482980310); // a start point

setInterval(function() {
  if (queue.isEmpty()) {
    console.log("Queue is empty now!");
    return;
  }

  var matchId = queue.dequeue();

  // retrieve match data
  LolApi.getMatch(matchId, false, 'na', function(err, matchData) {
    console.log("Retrieving match data for matchId: " + matchId + "... (Queue Size: " + queue.size() + ")");

    if (err) {
      console.log("Error: API Limits");
    } else if (matchData === null || matchData === undefined) {
      console.log("Error: data retrieved is null or undefined");
    } else {

      // 1. index matchId to AWS ES
      elasticsearch.index({
        index: 'loldata',
        type: 'matchId',
        body: {
          matchId: matchId
        }
      }, function(err, data) {
        if (err) {
          console.log("Error: fail to index matchId to AWS ES", err);
        } else {
          console.log("Step 1: index matchId to AWS ES ==> " + matchId);
        }
      });

      // 2. index all match data to AWS ES
      var matchDetailData = constructMatchData(matchData);

      elasticsearch.index({
        index: 'loldata',
        type: 'matchData',
        body: matchDetailData
      }, function(err, data) {
        if (err) {
          console.log("Error: fail to index matchData to AWS ES", err);
        } else {
          console.log("Step 2: index match data to AWS ES ==> " + matchDetailData.matchId);
        }
      });

      // 3. index summonerId to ES and refill the queue
      for (var i = 0; i < matchData.participantIdentities.length; i++) {
        var participantId = matchData.participantIdentities[i].player.summonerId;

        (function(participantId) {
          elasticsearch.search({
            index: 'loldata',
            type: 'summonerId',
            size: 1,
            body: {
              query: {
                term: {
                  "summonerId": participantId
                }
              }
            }
          }, function(err, data) {
            if (err) {
              console.log("Error: fail to search summonerId from AWS ES", err);
            } else {
              if (data.hits.hits.length === 0) {
                // index summonerId to AWS ES
                elasticsearch.index({
                  index: 'loldata',
                  type: 'summonerId',
                  body: {
                    summonerId: participantId
                  }
                }, function(err, data) {
                  if (err) {
                    console.log("Error: fail to index summonerId to AWS ES", err);
                  } else {
                    console.log("Step 3: index summonerId to AWS ES and push item into queue...\n");
                  }
                });

                // refill queue
                if (queue.size() < 100) {
                  var options = {
                    beginIndex: 1,
                    endIndex: 5
                  };

                  LolApi.getMatchHistory(participantId, options, 'na', function(err, data) {
                    if (err) {
                      console.log("Error: fail to fetch match list for summonerId ==> " + participantId);
                    } else {
                      var matchArray = data.matches;

                      if (matchArray !== undefined) {
                        for (var j = 0; j < matchArray.length; j++) {
                          var mId = matchArray[j].matchId;

                          (function(mId) {
                            elasticsearch.search({
                              index: 'loldata',
                              type: 'matchId',
                              size: 1,
                              body: {
                                query: {
                                  term: {
                                    "matchId": mId
                                  }
                                }
                              }
                            }, function(err, data) {
                              if (err) {
                                console.log("Error: fail to search matchId from AWS ES");
                              } else {
                                if (data.hits.hits.length === 0) {
                                  console.log("Queue enqueue =====> " + mId);
                                  queue.enqueue(mId);
                                }
                              }
                            });
                          })(mId);
                        }
                      }
                    }
                  });
                }
              }
            }
          });
        })(participantId);
      }
    }
  });

}, 2000);

var constructMatchData = function(data) {

  var matchData = {
    matchId: data.matchId,
    matchCreation: epoch(data.matchCreation).format('YYYY-MM-DD'),
    participants: [],
    teams: [{
      teamId: data.teams[0].teamId,
      winner: data.teams[0].winner,
      firstBlood: data.teams[0].firstBlood,
      firstTower: data.teams[0].firstTower,
      firstInhibitor: data.teams[0].firstInhibitor,
      bans: []
    }, {
      teamId: data.teams[1].teamId,
      winner: data.teams[1].winner,
      firstBlood: data.teams[1].firstBlood,
      firstTower: data.teams[1].firstTower,
      firstInhibitor: data.teams[1].firstInhibitor,
      bans: []
    }]
  };

  // fill participants array
  for (var i = 0; i < data.participants.length; i++) {
    var participant = data.participants[i];
    var championData = {
      name: championList[participant.championId].name,
      winner: participant.stats.winner,
      kills: participant.stats.kills,
      assists: participant.stats.assists,
      deaths: participant.stats.deaths,
      quadraKills: participant.stats.quadraKills,
      pentaKills: participant.stats.pentaKills,
      firstBlood: participant.stats.firstBloodKill
    };

    matchData.participants.push(championData);
  }

  // fill bans array of 2 teams
  for (var i = 0; i < data.teams[0].bans.length; i++) {
    matchData.teams[0].bans.push(championList[data.teams[0].bans[i].championId]);
  }

  for (var i = 0; i < data.teams[1].bans.length; i++) {
    matchData.teams[1].bans.push(championList[data.teams[1].bans[i].championId]);
  }

  return matchData;
}