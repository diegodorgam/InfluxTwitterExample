# InfluxTwitterExample

This example shows how easy it is to insert data points into InfluxDB for later
 processing and visual analysis.

# To run this sample:

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
