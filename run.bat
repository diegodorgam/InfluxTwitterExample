REM obtain your own Twitter keys via: https://apps.twitter.com/app/new
export TWITTER_CONSUMER_KEY=
export TWITTER_CONSUMER_SECRET=
export TWITTER_ACCESS_TOKEN_KEY=
export TWITTER_ACCESS_TOKEN_SECRET=
REM obtain your own Rosette key via: https://developer.rosette.com/
export ROSETTE_API_KEY=

node collectTweets.js --keywordSourceWordPressBasePath "http://paulsbruce.io"
