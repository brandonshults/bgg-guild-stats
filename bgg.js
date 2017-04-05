const xml2js = require('xml2js').parseString;
const LimitRequestPromise = require('limit-request-promise');
const fsExtra = require('fs-extra');
const json2csv = require('json2csv');
const stats = require('stats-lite');
const commander = require('commander');

const DEEP_CUTS_BGG_ID = 2708;

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

commander
  .version(require('./package.json').version)
  .option('-gid, --guild-id <n>', 'bgg guild id', parseInt)
  .option('-o, --outfile <path>', 'outfile name and location')
  .parse(process.argv);

const bggLimitedRequest = new LimitRequestPromise(1, 1);
bggLimitedRequest.setup([{
  host: 'www.boardgamegeek.com',
  max: 1,
  sec: 0.66
}]);



// Sometimes BGG API returns a message indicating that the results will be ready soon, in this case retry
function shouldRetryRequest(results) {
  return results && results.message && results.message.indexOf('and will be processed') > -1
}

function getUserCollection(username) {
  return bggLimitedRequest.req(`https://www.boardgamegeek.com/xmlapi2/collection?username=${username}&rated=1&stats=1`)
    .then(xml => new Promise((resolve, reject) => xml2js(xml, (err, result) => err ? resolve({}) : resolve(result))))
    .then(results => shouldRetryRequest(results) ? getUserCollection(username) : results)
}

function getUserRatings(username) {
  return getUserCollection(username)
    .then(collection => collection.items.item.map(item => ({
      name: item.name[0]._,
      rating: parseFloat(item.stats[0].rating[0].$.value),
      id: parseFloat(item.$.objectid)
    })).sort((a, b) => b.rating - a.rating))
    .catch(() => ([]))
}

function getRatingsForUsers(users) {
  const overallRatings = {};
  return Promise.all(users
    .map(user => getUserRatings(user)
      .then(userRatings => overallRatings[user] = userRatings)))
  .then(() => overallRatings);
}

function getGuildPage(guildId, pageNumber) {
  return bggLimitedRequest.req(`https://www.boardgamegeek.com/xmlapi2/guild?id=${guildId}&members=1&page=${pageNumber}`)
    .catch(console.log.bind(console))
    .then(xml => new Promise((resolve, reject) => xml2js(xml, (err, result) => err ? resolve([]) : resolve(result))))
    .then(results => results.guild.members[0].member.map(member => member.$.name))
    .catch(() => [])
}

function getGuildMembers(guildId, currentPage = 1, members = []) {
  return getGuildPage(guildId, currentPage)
    .then(addedMembers => addedMembers.length > 0 ? getGuildMembers(guildId, currentPage + 1, members.concat(addedMembers)) : members);
}

function getGuildRatings(guildId) {
  return getGuildMembers(guildId)
    .then(getRatingsForUsers);
}

function aggregateRatings(guildRatings) {
  return Object.keys(guildRatings).reduce((combined, guildRatingKey) => {
    guildRatings[guildRatingKey].forEach(rating => {
      combined[rating.id] = combined[rating.id] || { name: rating.name, ratings: [] };
      combined[rating.id].ratings.push(rating.rating);
    });
    return combined;
  }, {})
}

function generateCsv(aggregateRatings) {
  return json2csv({data: Object.keys(aggregateRatings).map(id => ({
    id,
    name: aggregateRatings[id].name,
    numberOfRatings: aggregateRatings[id].ratings.length,
    mean: stats.mean(aggregateRatings[id].ratings),
    median: stats.median(aggregateRatings[id].ratings),
    mode: stats.mode(aggregateRatings[id].ratings),
    variance: stats.variance(aggregateRatings[id].ratings),
    stDev: stats.stdev(aggregateRatings[id].ratings),
  })).sort((a, b) => b.mean - a.mean)})
}


const guildId = commander.guildId || DEEP_CUTS_BGG_ID;
const outfile = commander.outfile || './results/results.csv';
getGuildRatings(guildId).then(t => fsExtra.outputFileSync(outfile, generateCsv(aggregateRatings(t))));
