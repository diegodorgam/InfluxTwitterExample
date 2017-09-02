/*

Author: Paul Bruce (@paulsbruce, paulsbruce.io)
Purpose: a collector of streaming tweets for insertion into InfluxDB
To run:
  1. follow the InfluxData sandbox environment tutorial here:
    https://github.com/influxdata/sandbox

  2. create your own API keys, then set them as environment variables.

    For Twitter: create a new app called 'InfluxTwitter' at
    https://apps.twitter.com/app/new

    For Rosette: If you want sentiment analysis, sign up for a trial at
    https://developer.rosette.com/

    On Mac, set them in ~/.bash_profile

    export TWITTER_CONSUMER_KEY=
    export TWITTER_CONSUMER_SECRET=
    export TWITTER_ACCESS_TOKEN_KEY=
    export TWITTER_ACCESS_TOKEN_SECRET=
    export ROSETTE_API_KEY=

    On Windows, configure the run.bat file

  3. install latest Node distro and run this script from the command line:

    npm build && node collectTweets.js --keywordSourceWordPressBasePath "http://paulsbruce.io"


For a great overview of InfluxData architecture, read this article:
https://www.influxdata.com/time-series-platform/telegraf/

To learn about using Promises in Node.js, see: http://bit.ly/Node-Promises

*/

// parse command line arguments
const argv = require("yargs").argv;

// create a simple step execution queue
var queue = require("queue");
var q = queue( { autostart: true });

// confirm environmental variables
if(!process.env.TWITTER_CONSUMER_KEY) { throw new Error("You must define your Twitter keys as system environment variables."); }

// simplify debug message toggle
console.debug = function(args) { if (argv.debug) { console.log("[debug] " + args); } };

//configure Twitter API
var Twitter = require("twitter");
var client = new Twitter({
  consumer_key: process.env.TWITTER_CONSUMER_KEY,
  consumer_secret: process.env.TWITTER_CONSUMER_SECRET,
  access_token_key: process.env.TWITTER_ACCESS_TOKEN_KEY,
  access_token_secret: process.env.TWITTER_ACCESS_TOKEN_SECRET
});
console.debug("Twitter Consumer: " + process.env.TWITTER_CONSUMER_KEY);

// configure text analysis API - eventually move this to a Kapacitor plugin, widen the inbound stream https://www.influxdata.com/time-series-platform/telegraf/
var rste = undefined;
if(argv.sentiment != false && process.env.ROSETTE_API_KEY && process.env.ROSETTE_API_KEY.length > 0) {
  var RosetteApi = require("rosette-api");
  rste = new RosetteApi(process.env.ROSETTE_API_KEY);
  rste.parameters.language = "eng";
}

// load profanity filter
var profanity = require("profanity-util");

// file system for test data caching
var file = require("file-system");
var fs = require("fs");

// retry promises such as HTTP requests
var promiseRetry = require('promise-retry');

// synchronous HTTP for initial keywords
const dns = require("dns");
var request = require("request");
//TODO:var deasync = require("deasync");

// include jsonpath for dynamic keyword source parsing
var jp = require("jsonpath");




/*
*** InfluxDB configuration ***
Set up InfluxDB schema of points insertions to InfluxDB; create DB if necessary
*/
const dbname = "twitter";
const measure = "tweets";
const Influx = require("influx");
const influx = new Influx.InfluxDB({
 host: "localhost",
 database: dbname,
 schema: [
   {
     measurement: "tweets",
     fields: {
       tweetid: Influx.FieldType.INTEGER,
       relevance: Influx.FieldType.FLOAT,
       user: Influx.FieldType.STRING,
       volatile: Influx.FieldType.BOOLEAN,
       raw: Influx.FieldType.STRING
     },
     tags: [
       "keywords"
     ]
   }
 ]
});
// create the database if it doesn't already exist (happens in parallel with initialization below)
q.push(function() {
  influx.getDatabaseNames()
    .then(names => {
      if (!names.includes(dbname)) {
        return influx.createDatabase(dbname);
      }
    });
});

// push initialization into the queue, but start at end of script after all other declarations (readability)
q.push(async function () {

  console.log("Initializing execution queue.");

  var ctx = { // runtime context (replacing shared golbal variables)
    // dynamic parameters
    debug: argv.debug,
    useTestData: argv.test,
    cacheData: argv.cache,

    // static variables
    testDataDir: "tweets/",
    isConnected: checkInternet(),

    // variables to load
    keywords: [],
    friendlies: [],
    exprFindAnyKeyword: null,
    dynamicKeywordSources: null

  };

  // Simplified keyword source extraction for WordPress lovers :)
  // Query syntax: https://developer.wordpress.org/rest-api/reference/tags/#list-tags
  // Example JSON: http://paulsbruce.io/wp-json/wp/v2/tags
  var wpbp = argv.keywordSourceWordPressBasePath;
  if(wpbp && wpbp.length > 0)
  {
    if(wpbp[wpbp.length-1] != "/") wpbp += "/";
    var srcs = ["tags","categories"].map(function(part) {
      return {
        url: wpbp + "wp-json/wp/v2/"+part+"?order_by=count&order=desc&hide_empty=true&per_page=100",
        path: "$..name"
      };
    });
    // try first source
    await Promise.all([
      extractKeywords(srcs[0])
        .then(function() {
          argv.keywordSources = srcs.map(function(src) { return src.path+";"+src.url; }).join(";")
        })
        .catch(function(err) {
          argv.keywordSources = null
          console.error(err)
        })
    ]);
  }

  // full keyword source extraction based on arbitrary JSON source;
  // example: --keywordSources "$..value;http://yourdomain.com/jsonFeed"
  var kwdsrc = argv.keywordSources ? argv.keywordSources.split(";") : [];
  if(kwdsrc && kwdsrc.length > 0) {
    if(kwdsrc.length % 2 != 0) {
      console.error("Invalid keywordSources parameter. Must be a semicolon delimited list of jsonPath;url values.");
    } else {
      var sources = [];
      for(var i=0; i<kwdsrc.length; i+=2) {
        if(i == (kwdsrc.length-1))
          break;
        sources.push({
          path: kwdsrc[i],
          url: kwdsrc[i+1]
        });
      }
      ctx.dynamicKeywordSources = sources;
    }
  }

  await Promise.all([
    loadKeywords(ctx)
      .then((kwds) => {
        ctx.keywords = kwds;
        ctx.exprFindAnyKeyword = new RegExp(kwds.map(function(s) { return s.toLowerCase()}).join("|"));
        console.debug("Keywords: " + ctx.keywords);
      })
    ,
    loadFriendlies(ctx)
      .then((frnds) => {
        ctx.friendlies = frnds;
        console.debug("Friendlies: " + ctx.friendlies);
      })
    ,
    (ctx.useTestData ? loadTestData(ctx)
      .then((td) => {
        ctx.testData = td;
        console.debug("Loaded test data ['+ctx.testData.length+']");
      })
      : function() {})
  ]);

  console.debug("Initialization complete. Processing events.");

  // on to the next one; now that context is prepped, processing can begin
  q.push(function(cb) {
    beginProcessEvents(ctx);
    cb();
  });
});





// use dns against google to determine internet connectivity, return syncronously
function checkInternet() {
    let isConnected = dns.lookup("google.com",function(err) {
          return ! (err && err.code == "ENOTFOUND");
      });
    return Promise.resolve(isConnected);
}

// pull keywords from personal blog, what's in my wheelhouse, so not all of Twitter firehose is streamed
async function loadKeywords(ctx) {
  var results = [];
  if(ctx.isConnected && ctx.dynamicKeywordSources.length > 0) {
    console.debug("Extracting keywords from sources...");
    await Promise.all(
      ctx.dynamicKeywordSources.map( async (src) => {
        var values = await extractKeywords(src);
        results.extend(values);
      })
    );
  }
  if(results.length < 1) // use static data in case of no network connectivity
  {
    console.debug("Using static keywords.");
    results = "API,API design,API documentation,testing".split(",");
  }
  // truncate to keywords that meet Twitter track/filter requirements
  results = results.unique()
    .filter(function(it) { return it.length <= 60; })
    .slice(0, 400)
    .sort();

  return results;
}
async function extractKeywords(source) {
  var json = await get(source.url)
    .then(JSON.parse)
    .catch(function(err) {
      console.error("Could not parse source '" + source + "'", err)
    });
  return json.map(function(obj) { return jp.value(obj, source.path); });
}

async function loadFriendlies(ctx) {
  var friendlies = [];
  if(ctx.isConnected) { // collect a list of users to really pay attention to, based on my retweets (who i've trusted enough)
     friendlies = await client.get("statuses/user_timeline", { include_rts: true, count:200 })
      .then(function(tweets) {
          console.debug("tweeets" + tweets.length);
          return tweets
            .filter(function(it) { return it.retweeted })
            .map(function(it) { return it.retweeted_status.user.screen_name.toLowerCase(); })
            .unique()
            .sort();
      })
      .catch(function(err) {
        console.debug("Failed to extract friendlies from online sources. " + err)
        return []
      });
  } else {
    friendlies = "TechCrunch,TheNewStack,Vice,CNN".split(","); // load with some arbitrary defaults
  }
  return friendlies;
}

async function loadTestData(ctx) {
  var testData = [];
  if(ctx.useTestData) {
    console.debug("Loading test data from cached responses in file-system.");
    var dir = ctx.testDataDir;
    var files = [];
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir);
    }
    file.recurseSync(dir, ["*.json"], function(filepath, relative, filename) {
      files.push(filename);
    });
    files.sort().reverse();
    var iFile;
    for(iFile=0; iFile<files.length; iFile++) {
      if(iFile >= 50) break;
      var event = JSON.parse(fs.readFileSync(dir+files[iFile]));
      testData.push(event);
    }
    for(; iFile<files.length; iFile++) {
      fs.unlinkSync(dir+files[iFile]);
    }
    if(testData.length < 1) {
      console.debug("No data on file-system, using static test data.");
      testData = createTestData();
    }
  }
  return testData;
}

function beginProcessEvents(ctx) {

  if(ctx.useTestData) {

    ctx.testData.forEach(function(event) {
      q.push(function() {
        onTwitterEvent(event, ctx);
      });
    });

  } else {

    console.log("Listening to twitter user feed for new events.");

    // retry twitter stream up to 5 times
    promiseRetry(function (retry, number) { // https://www.npmjs.com/package/promise-retry
        console.info('attempt number', number);

        return createTwitterStream(ctx)
          .catch(function(err) {
            console.log(err)
            if(number <= 5) retry(err);
            throw err
          });
    })
    .catch(err => {
      console.log('Epic failure to establish Twitter stream after multiple attempts.')
      throw err;
    });


  }
}

async function createTwitterStream(ctx) {
  return new Promise(function(resolve, reject) {
    try {
      client.stream("user", { }, function(stream) { // https://www.npmjs.com/package/twitter
        resolve(stream);
        stream.on("data", function(event) {

          q.push(function() {
            onTwitterEvent(event, ctx);
          });

          if(ctx.cacheData) {
            q.push(function() {
              var filePath = ctx.testDataDir+event.id_str+".json";
              fs.writeFile(filePath, JSON.stringify(event), function(error) {
                if(error) { console.error("Could not save file: " + filePath + "\n" + JSON.stringify(err)); }
              });
            });
          }
        });
        stream.on("error", function(error) {
          console.error(error)
          reject(err);
        });
      });
    } catch(err) {
      reject(err);
    }
  })
}

// Handle a raw twitter event, potentially passing it on into InfluxDB
// Static JSON example of Twitter event structure: https://gist.github.com/hrp/900964
function onTwitterEvent(event, ctx) {

  console.info(event.user.screen_name + " -> " + event.text.replace("\n',' "));

  var blockedwords = profanity.check(event.text);
  if(blockedwords.length > 0) { // will be used to inform points of volatility for later stage auto-retweet
    console.debug("Profanity filter caught: " + JSON.stringify(blockedwords) + " in " + event.text);
  }

  var matches = event.text.toLowerCase().match(ctx.exprFindAnyKeyword);

  var result = {
    "event": event,
    "tweetid": event.id_str,
    "relevance": 0,
    "user": event.user.screen_name,
    "volatile": (blockedwords.length > 0), // profanity
    "tags": [],
    "sentiment": null
  };
  if (matches && matches.length > 0) {

      result.tags.extend(matches); // add tags based on keywords that matched

      if(rste) { q.push(function() { processSentiments(event, matches, result, ctx) }); }

  } else {
    q.push(function() { afterMatchFound(result, ctx); }); // after no match determination made
  }
}

// once an event is deemed to contain a minimum relevance and keywords(tags), write to InfluxDB
function afterMatchFound(result, ctx) {

  if(ctx.friendlies.indexOf(result.user.toLowerCase()) > -1) {
    result.relevance += ((1.0 - result.relevance) * 0.5); // up the relevance because it comes from a friendly
  }

  if(result.tags.length > 0) { // result.relevance
    console.debug("Found relevant match" + (result.volatile ? " [VOLATILE]" : "") + ".");
    console.debug(result.tweetid + " ["+result.relevance+"]: " + JSON.stringify(result.tags));

    // send through to InfluxDB
    influx.writePoints([
      {
        measurement: "tweets",
        tags: {
          keywords: (result.tags.length > 0 ? result.tags.join(",") : [])
        },
        fields: {
          tweetid: result.tweetid,
          relevance: result.relevance,
          user: result.user,
          volatile: result.volatile,
          raw: JSON.stringify(result)
        },
      }
    ]).catch(err => {
      console.error(`Error saving data to InfluxDB! ${err.stack}`);
    });

  } else {
    console.debug("Event not found to be relevant.");
  }
}

// send event text to sentiment analysis for clarified tag filtering
// eventually move this to Kapacitor plugin for offline analysis
function processSentiments(event, matches, result, ctx) {
  if(!rste) return;
  console.debug("Found match...sending to sentiment analysis.");
  rste.parameters.content = event.text;
  rste.rosette("sentiment", function(err, sen) {
    if(err) {
      console.error("Error processing sentiments.", err);
    } else {
      result.sentiment = sen;
      var confidences = [];
      sen.entities.forEach(function(entity) {
        switch(entity.type) {
          case "PRODUCT":
          case "ORGANIZATION":
          case "TITLE":
          case "LOCATION":
            // if entity clarified, add to confidences for later summation
            if(matches.indexOf(entity.mention.toLowerCase()) > -1) {
              console.debug("Clarified topic: " + entity.mention);
              confidences.push(entity.sentiment.confidence);
            }
            break;
        };
      })
      if(confidences.length > 0) { // sum confidences and set relevance
        var sum = confidences.reduce(function(a, b) { return a + b; });
        var avg = sum / confidences.length;
        result.relevance = avg;
      }
    }
    // once completed, push to next step
    q.push(function() { afterMatchFound(result, ctx); })
  });
}






// strictly helper functions

// simple helper for HTTP get requests
async function get(url) {
  return new Promise(function (resolve, reject) {
    var userAgent = {"User-Agent": "Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/47.0.2526.111 Safari/537.36"};
    request({
       url: url,
       headers: userAgent
    },
    function (error, res, body) {
      if (!error && res.statusCode == 200) {
        resolve(body);
      } else {
        reject(error);
      }
    });
  });
}

// helper functions over arrays
Array.prototype.unique = function() {
    var a = this.concat();
    for(var i=0; i<a.length; ++i) {
      for(var j=i+1; j<a.length; ++j) {
        if(a[i] === a[j]) a.splice(j--, 1);
      }
    }
    return a;
};
Array.prototype.extend = function (other_array) {
    other_array.forEach(function(v) { this.push(v) }, this);
}

function createTestData() {
  var results = [];
  results.push({"created_at":"Tue Aug 29 13:08:27 +0000 2017","id":902518307445772300,"id_str":"902518307445772288","text":"The latest DevOps Evolution! https://t.co/UgSnP7jJ11 Thanks to @AbdurRa93942279 @DevOpsDaysDFW @ElAutoestopista #devops #opines","source":"<a href=\"http://paper.li\" rel=\"nofollow\">Paper.li</a>","truncated":false,"in_reply_to_status_id":null,"in_reply_to_status_id_str":null,"in_reply_to_user_id":null,"in_reply_to_user_id_str":null,"in_reply_to_screen_name":null,"user":{"id":21059342,"id_str":"21059342","name":"Althea Champagnie","screen_name":"Champagnie","location":"Hawaii, USA","url":"http://about.me/champagnie","description":"Ph.D. Eng. @Microsoft on #interop. #Scifi geek passionate abt giving back, #education #science #technology #innovation #DevOps #IoT Jamaica. Personal account.","protected":false,"verified":false,"followers_count":113464,"friends_count":28384,"listed_count":754,"favourites_count":4950,"statuses_count":27483,"created_at":"Tue Feb 17 03:13:53 +0000 2009","utc_offset":-28800,"time_zone":"Alaska","geo_enabled":true,"lang":"en","contributors_enabled":false,"is_translator":false,"profile_background_color":"C6E2EE","profile_background_image_url":"http://abs.twimg.com/images/themes/theme2/bg.gif","profile_background_image_url_https":"https://abs.twimg.com/images/themes/theme2/bg.gif","profile_background_tile":false,"profile_link_color":"1F98C7","profile_sidebar_border_color":"C6E2EE","profile_sidebar_fill_color":"DAECF4","profile_text_color":"663B12","profile_use_background_image":true,"profile_image_url":"http://pbs.twimg.com/profile_images/378800000408226227/b6d6ad2fea7e113556071314575d64a3_normal.jpeg","profile_image_url_https":"https://pbs.twimg.com/profile_images/378800000408226227/b6d6ad2fea7e113556071314575d64a3_normal.jpeg","profile_banner_url":"https://pbs.twimg.com/profile_banners/21059342/1398288023","default_profile":false,"default_profile_image":false,"following":null,"follow_request_sent":null,"notifications":null},"geo":null,"coordinates":null,"place":null,"contributors":null,"is_quote_status":false,"retweet_count":0,"favorite_count":0,"entities":{"hashtags":[{"text":"devops","indices":[112,119]},{"text":"opines","indices":[120,127]}],"urls":[{"url":"https://t.co/UgSnP7jJ11","expanded_url":"http://paper.li/Champagnie/1351472941?edition_id=2463c220-8cbb-11e7-a0f6-002590a5ba2d","display_url":"paper.li/Champagnie/135…","indices":[29,52]}],"user_mentions":[{"screen_name":"AbdurRa93942279","name":"Social Business","id":878518000512450600,"id_str":"878518000512450560","indices":[63,79]},{"screen_name":"DevOpsDaysDFW","name":"DevOpsDays DFW","id":700517015925043200,"id_str":"700517015925043200","indices":[80,94]},{"screen_name":"ElAutoestopista","name":"Doctor BOFHenshmirtz","id":146365491,"id_str":"146365491","indices":[95,111]}],"symbols":[]},"favorited":false,"retweeted":false,"possibly_sensitive":false,"filter_level":"low","lang":"en","timestamp_ms":"1504012107131"});
  results.push({"created_at":"Tue Aug 29 13:08:05 +0000 2017","id":902518214961152000,"id_str":"902518214961152002","text":"Stop Calling Google’s Chromebooks Toy Computers https://t.co/TeZcvBL1Hp #security https://t.co/mRVkiIsMRy","display_text_range":[0,81],"source":"<a href=\"https://dlvrit.com/\" rel=\"nofollow\">dlvr.it</a>","truncated":false,"in_reply_to_status_id":null,"in_reply_to_status_id_str":null,"in_reply_to_user_id":null,"in_reply_to_user_id_str":null,"in_reply_to_screen_name":null,"user":{"id":16309969,"id_str":"16309969","name":"Eric Vanderburg","screen_name":"evanderburg","location":"Cleveland, OH","url":"https://securitythinkingcap.com","description":"Cybersecurity, Privacy, and Tech Leader, Author, Consultant, and Speaker, VP, Cybersecurity @TCDI http://tcdi.com","translator_type":"none","protected":false,"verified":true,"followers_count":136525,"friends_count":5216,"listed_count":4549,"favourites_count":212,"statuses_count":289183,"created_at":"Tue Sep 16 12:46:12 +0000 2008","utc_offset":-14400,"time_zone":"Eastern Time (US & Canada)","geo_enabled":false,"lang":"en","contributors_enabled":false,"is_translator":false,"profile_background_color":"000000","profile_background_image_url":"http://pbs.twimg.com/profile_background_images/378800000147632613/l1HSnocR.jpeg","profile_background_image_url_https":"https://pbs.twimg.com/profile_background_images/378800000147632613/l1HSnocR.jpeg","profile_background_tile":false,"profile_link_color":"404040","profile_sidebar_border_color":"000000","profile_sidebar_fill_color":"1C1939","profile_text_color":"777777","profile_use_background_image":true,"profile_image_url":"http://pbs.twimg.com/profile_images/873547765078425600/VOO8iCGT_normal.jpg","profile_image_url_https":"https://pbs.twimg.com/profile_images/873547765078425600/VOO8iCGT_normal.jpg","profile_banner_url":"https://pbs.twimg.com/profile_banners/16309969/1497577269","default_profile":false,"default_profile_image":false,"following":null,"follow_request_sent":null,"notifications":null},"geo":null,"coordinates":null,"place":null,"contributors":null,"is_quote_status":false,"quote_count":0,"reply_count":0,"retweet_count":0,"favorite_count":0,"entities":{"hashtags":[{"text":"security","indices":[72,81]}],"urls":[{"url":"https://t.co/TeZcvBL1Hp","expanded_url":"http://i.securitythinkingcap.com/PjNw2t","display_url":"i.securitythinkingcap.com/PjNw2t","indices":[48,71]}],"user_mentions":[],"symbols":[],"media":[{"id":902518212448870400,"id_str":"902518212448870400","indices":[82,105],"media_url":"http://pbs.twimg.com/media/DIZjiFBV4AAf7IF.jpg","media_url_https":"https://pbs.twimg.com/media/DIZjiFBV4AAf7IF.jpg","url":"https://t.co/mRVkiIsMRy","display_url":"pic.twitter.com/mRVkiIsMRy","expanded_url":"https://twitter.com/evanderburg/status/902518214961152002/photo/1","type":"photo","sizes":{"large":{"w":720,"h":499,"resize":"fit"},"small":{"w":680,"h":471,"resize":"fit"},"thumb":{"w":150,"h":150,"resize":"crop"},"medium":{"w":720,"h":499,"resize":"fit"}}}]},"extended_entities":{"media":[{"id":902518212448870400,"id_str":"902518212448870400","indices":[82,105],"media_url":"http://pbs.twimg.com/media/DIZjiFBV4AAf7IF.jpg","media_url_https":"https://pbs.twimg.com/media/DIZjiFBV4AAf7IF.jpg","url":"https://t.co/mRVkiIsMRy","display_url":"pic.twitter.com/mRVkiIsMRy","expanded_url":"https://twitter.com/evanderburg/status/902518214961152002/photo/1","type":"photo","sizes":{"large":{"w":720,"h":499,"resize":"fit"},"small":{"w":680,"h":471,"resize":"fit"},"thumb":{"w":150,"h":150,"resize":"crop"},"medium":{"w":720,"h":499,"resize":"fit"}}}]},"favorited":false,"retweeted":false,"possibly_sensitive":false,"filter_level":"low","lang":"en","timestamp_ms":"1504012085081"});
  return results;
}

// create filter for tweet data to just tweets, per Twitter documentation
_ = require("lodash")
const isTweet = _.conforms({ contributors: _.isObject, id_str: _.isString, text: _.isString });


// finally, make sure the step execution queue is running
q.start();
