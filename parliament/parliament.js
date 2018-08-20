#!/usr/bin/env node
'use strict';

/* dependencies ------------------------------------------------------------- */
const express = require('express');
const path    = require('path');
const http    = require('http');
const https   = require('https');
const fs      = require('fs');
const favicon = require('serve-favicon');
const rp      = require('request-promise');
const bp      = require('body-parser');
const logger  = require('morgan');
const jwt     = require('jsonwebtoken');
const bcrypt  = require('bcrypt');
const glob    = require('glob');

/* app setup --------------------------------------------------------------- */
const app     = express();
const router  = express.Router();

const version = 1;

const saltrounds = 13;

const issueTypes = {
  esRed: { on: true, name: 'ES Red', text: 'ES is red', severity: 'red', description: 'ES status is red' },
  esDown: { on: true, name: 'ES Down', text: ' ES is down', severity: 'red', description: 'ES is unreachable' },
  esDropped: { on: true, name: 'ES Dropped', text: 'ES is dropping bulk inserts', severity: 'yellow', description: 'the capture node is overloading ES' },
  outOfDate: { on: true, name: 'Out of Date', text: 'has not checked in since', severity: 'red', description: 'the capture node has not checked in' },
  noPackets: { on: true, name: 'No Packets', text: 'is not receiving packets', severity: 'red', description: 'the capture node is not receiving packets' }
};

const settingsDefault = {
  general : {
    outOfDate: 30,
    esQueryTimeout: 5,
    removeIssuesAfter: 60,
    removeAcknowledgedAfter: 15
  },
  notifiers: {}
};

(function () { // parse arguments
  let appArgs = process.argv.slice(2);
  let file, port;

  function setPasswordHash (err, hash) {
    if (err) {
      console.error(`Error hashing password: ${err}`);
      return;
    }

    app.set('password', hash);
  }

  function help () {
    console.log('server.js [<config options>]\n');
    console.log('Config Options:');
    console.log('  -c, --config   Parliament config file to use');
    console.log('  --pass         Password for updating the parliament');
    console.log('  --port         Port for the web app to listen on');
    console.log('  --cert         Public certificate to use for https');
    console.log('  --key          Private certificate to use for https');

    process.exit(0);
  }

  for (let i = 0, len = appArgs.length; i < len; i++) {
    switch (appArgs[i]) {
      case '-c':
      case '--config':
        file = appArgs[i + 1];
        i++;
        break;

      case '--pass':
        bcrypt.hash(appArgs[i + 1], saltrounds, setPasswordHash);
        i++;
        break;

      case '--port':
        port = appArgs[i + 1];
        i++;
        break;

      case '--cert':
        app.set('certFile', appArgs[i + 1]);
        i++;
        break;

      case '--key':
        app.set('keyFile', appArgs[i + 1]);
        i++;
        break;

      case '--regressionTests':
        app.set('regressionTests', 1);
        break;

      case '--debug':
        // Someday support debug :)
        break;

      case '-h':
      case '--help':
        help();
        break;

      default:
        console.log(`Unknown option ${appArgs[i]}`);
        help();
        break;
    }
  }

  if (!appArgs.length) {
    console.log('WARNING: No config options were set, starting Parliament in view only mode with defaults.\n');
  }

  // set optional config options that reqiure defaults
  app.set('port', port || 8008);
  app.set('file', file || './parliament.json');
}());

if (app.get('regressionTests')) {
  app.post('/shutdown', function (req, res) {
    process.exit(0);
  });
};

// get the parliament file or create it if it doesn't exist
let parliament;
try {
  parliament = require(`${app.get('file')}`);
  // set the password if passed in when starting the server
  // IMPORTANT! this will overwrite any password in the parliament json file
  if (app.get('password')) {
    parliament.password = app.get('password');
  } else if (parliament.password) {
    // if the password is not supplied when starting the server,
    // use any existing password in the parliament json file
    app.set('password', parliament.password);
  }
} catch (err) {
  parliament = {
    version: version,
    groups: [],
    settings: settingsDefault
  };
}

// construct the issues file name
let issuesFilename = 'issues.json';
if (app.get('file').indexOf('.json') > -1) {
  let name = app.get('file').replace(/\.json/g, '');
  issuesFilename = `${name}.issues.json`;
}
app.set('issuesfile', issuesFilename);

// get the issues file or create it if it doesn't exist
let issues;
try {
  issues = require(issuesFilename);
} catch (err) {
  issues = [];
}

// define ids for groups and clusters
let groupId = 0;
let clusterId = 0;

app.disable('x-powered-by');

// expose vue bundles (prod)
app.use('/parliament/static', express.static(`${__dirname}/vueapp/dist/static`));
// expose vue bundle (dev)
app.use(['/app.js', '/vueapp/app.js'], express.static(`${__dirname}/vueapp/dist/app.js`));

app.use('/parliament/font-awesome', express.static(`${__dirname}/../node_modules/font-awesome`, { maxAge: 600 * 1000 }));

// log requests
app.use(logger('dev'));

app.use(favicon(`${__dirname}/favicon.ico`));

// define router to mount api related functions
app.use('/parliament/api', router);
router.use(bp.json());
router.use(bp.urlencoded({ extended: true }));

let internals = {
  notifiers: {}
};

// Load notifier plugins for Parliament alerting
function loadNotifiers () {
  var api = {
    register: function (str, info) {
      internals.notifiers[str] = info;
    }
  };

  // look for all notifier providers and initialize them
  let files = glob.sync(path.join(__dirname, '/notifiers/provider.*.js'));
  files.forEach((file) => {
    let plugin = require(file);
    plugin.init(api);
  });
}

loadNotifiers();

/* Middleware -------------------------------------------------------------- */
// App should always have parliament data
router.use((req, res, next) => {
  if (!parliament) {
    const error = new Error('Unable to fetch parliament data.');
    error.httpStatusCode = 500;
    return next(error);
  }

  next();
});

// Handle errors
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.httpStatusCode || 500).json({
    success : false,
    text    : err.message || 'Error'
  });
});

// Verify token
function verifyToken (req, res, next) {
  function tokenError (req, res, errorText) {
    errorText = errorText || 'Token Error!';
    res.status(403).json({
      tokenError: true,
      success   : false,
      text      : `Permission Denied: ${errorText}`
    });
  }

  let hasAuth = !!app.get('password');
  if (!hasAuth) {
    return tokenError(req, res, 'No password set.');
  }

  // check for token in header, url parameters, or post parameters
  let token = req.body.token || req.query.token || req.headers['x-access-token'];

  if (!token) {
    return tokenError(req, res, 'No token provided.');
  }

  // verifies token and expiration
  jwt.verify(token, app.get('password'), (err, decoded) => {
    if (err) {
      return tokenError(req, res, 'Failed to authenticate token. Try logging in again.');
    } else {
      // if everything is good, save to request for use in other routes
      req.decoded = decoded;
      next();
    }
  });
}

/* Helper functions -------------------------------------------------------- */
// list of alerts that will be sent at every 10 seconds
let alerts = [];
// sends alerts in the alerts list
async function sendAlerts () {
  let promise = new Promise((resolve, reject) => {
    for (let i = 0, len = alerts.length; i < len; i++) {
      (function (i) {
        // timeout so that alerts are alerted in order
        setTimeout(() => {
          let alert = alerts[i];
          alert.notifier.sendAlert(alert.config, alert.message);
          if (i === len - 1) { resolve(); }
        }, 250 * i);
      })(i);
    };
  });

  promise.then(() => {
    alerts = []; // clear the queue
  });
}

// sorts the list of alerts by cluster title then sends them
// assumes that the alert message starts with the cluster title
function processAlerts () {
  if (alerts && alerts.length) {
    alerts.sort((a, b) => {
      return a.message.localeCompare(b.message);
    });

    sendAlerts();
  }
}

function formatIssueMessage (cluster, issue) {
  let message = '';

  if (issue.node) { message += `${issue.node} `; }

  message += `${issue.text}`;

  if (issue.value) {
    let value = ': ';

    if (issue.type === 'esDropped') {
      value += issue.value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    } else if (issue.type === 'outOfDate') {
      value += new Date(issue.value);
    } else {
      value += issue.value;
    }

    message += `${value}`;
  }

  return message;
}

function buildAlert (cluster, issue) {
  issue.alerted = Date.now();

  const message = `${cluster.title} - ${issue.message}`;

  for (let n in internals.notifiers) {
    // quit before sending the alert if the notifier is off
    if (!parliament.settings.notifiers || !parliament.settings.notifiers[n] || !parliament.settings.notifiers[n].on) {
      continue;
    }

    const notifier = internals.notifiers[n];

    // quit before sending the alert if the alert is off
    if (!parliament.settings.notifiers[n].alerts[issue.type]) {
      continue;
    }

    let config = {};

    for (let f of notifier.fields) {
      let field = parliament.settings.notifiers[n].fields[f.name];
      if (!field || (field.required && !field.value)) {
        // field doesn't exist, or field is required and doesn't have a value
        console.error(`Missing the ${field.name} field for ${n} alerting. Add it on the settings page.`);
        continue;
      }
      config[f.name] = field.value;
    }

    alerts.push({
      config: config,
      message: message,
      notifier: notifier
    });
  }
}

// Finds an issue in a cluster
function findIssue (clusterId, issueType, node) {
  for (let issue of issues) {
    if (issue.clusterId === clusterId &&
      issue.type === issueType &&
      issue.node === node) {
      return issue;
    }
  }
}

// Updates an existing issue or pushes a new issue onto the issue array
function setIssue (cluster, newIssue) {
  // build issue
  let issueType       = issueTypes[newIssue.type];
  newIssue.text       = issueType.text;
  newIssue.title      = issueType.name;
  newIssue.severity   = issueType.severity;
  newIssue.clusterId  = cluster.id;
  newIssue.cluster    = cluster.title;
  newIssue.message    = formatIssueMessage(cluster, newIssue);

  let existingIssue = false;

  // don't duplicate existing issues, update them
  for (let issue of issues) {
    if (issue.clusterId === newIssue.clusterId &&
        issue.type === newIssue.type &&
        issue.node === newIssue.node) {
      existingIssue = true;
      if (Date.now() > issue.ignoreUntil && issue.ignoreUntil !== -1) {
        // the ignore has expired, so alert!
        issue.ignoreUntil = undefined;
        issue.alerted     = undefined;
      }

      issue.lastNoticed = Date.now();

      if (!issue.acknowledged && !issue.ignoreUntil && !issue.alerted) {
        buildAlert(cluster, issue);
      }
    }
  }

  if (!existingIssue) {
    newIssue.firstNoticed = Date.now();
    newIssue.lastNoticed = Date.now();
    issues.push(newIssue);
    buildAlert(cluster, newIssue);
  }

  fs.writeFile(app.get('issuesfile'), JSON.stringify(issues, null, 2), 'utf8',
    (err) => {
      if (err) {
        console.error('Unable to write issue:', err.message || err);
      }
    }
  );
}

// Retrieves the health of each cluster and updates the cluster with that info
function getHealth (cluster) {
  return new Promise((resolve, reject) => {
    let timeout = getGeneralSetting('esQueryTimeout') * 1000;

    let options = {
      url: `${cluster.localUrl || cluster.url}/eshealth.json`,
      method: 'GET',
      rejectUnauthorized: false,
      timeout: timeout
    };

    rp(options)
      .then((response) => {
        cluster.healthError = undefined;

        let health;
        try {
          health = JSON.parse(response);
        } catch (e) {
          cluster.healthError = 'ES health parse failure';
          console.error('Bad response for es health', cluster.localUrl || cluster.url);
          return resolve();
        }

        if (health) {
          cluster.status      = health.status;
          cluster.totalNodes  = health.number_of_nodes;
          cluster.dataNodes   = health.number_of_data_nodes;

          if (cluster.status === 'red') { // alert on red es status
            setIssue(cluster, { type: 'esRed' });
          }
        }

        return resolve();
      })
      .catch((error) => {
        let message = error.message || error;

        setIssue(cluster, { type: 'esDown', value: message });

        cluster.healthError = message;

        console.error('HEALTH ERROR:', options.url, message);
        return resolve();
      });
  });
}

// Retrieves, then calculates stats for each cluster and updates the cluster with that info
function getStats (cluster) {
  return new Promise((resolve, reject) => {
    let timeout = getGeneralSetting('esQueryTimeout') * 1000;

    let options = {
      url: `${cluster.localUrl || cluster.url}/stats.json`,
      method: 'GET',
      rejectUnauthorized: false,
      timeout: timeout
    };

    // Get now before the query since we don't know how long query/response will take
    let now = Date.now() / 1000;
    rp(options)
      .then((response) => {
        cluster.statsError = undefined;

        if (response.bsqErr) {
          cluster.statsError = response.bsqErr;
          console.error('Get stats error', response.bsqErr);
          return resolve();
        }

        let stats;
        try {
          stats = JSON.parse(response);
        } catch (e) {
          cluster.statsError = 'ES stats parse failure';
          console.error('Bad response for stats', cluster.localUrl || cluster.url);
          return resolve();
        }

        if (!stats || !stats.data) { return resolve(); }

        cluster.deltaBPS = 0;
        // sum delta bytes per second
        for (let stat of stats.data) {
          if (stat.deltaBytesPerSec) {
            cluster.deltaBPS += stat.deltaBytesPerSec;
          }
        }

        cluster.deltaTDPS = 0;
        // sum delta total dropped per second
        for (let stat of stats.data) {
          if (stat.deltaTotalDroppedPerSec) {
            cluster.deltaTDPS += stat.deltaTotalDroppedPerSec;
          }
        }

        // Look for issues
        for (let stat of stats.data) {
          let outOfDate = getGeneralSetting('outOfDate') * 1000;

          if ((now - stat.currentTime) > outOfDate) {
            setIssue(cluster, {
              type  : 'outOfDate',
              node  : stat.nodeName,
              value : stat.currentTime * 1000
            });
          }

          if (stat.deltaPacketsPerSec === 0) {
            setIssue(cluster, {
              type: 'noPackets',
              node: stat.nodeName
            });
          }

          if (stat.deltaESDroppedPerSec > 0) {
            setIssue(cluster, {
              type  : 'esDropped',
              node  : stat.nodeName,
              value : stat.deltaESDroppedPerSec
            });
          }
        }

        return resolve();
      })
      .catch((error) => {
        let message = error.message || error;
        console.error('STATS ERROR:', options.url, message);

        setIssue(cluster, { type: 'esDown', value: message });

        cluster.statsError = message;
        return resolve();
      });
  });
}

function buildNotifiers () {
  // build notifiers
  for (let n in internals.notifiers) {
    // if the notifier is not in settings, add it
    if (!parliament.settings.notifiers[n]) {
      const notifier = internals.notifiers[n];

      let notifierData = { name: n, fields: {}, alerts: {} };

      // add fields to notifier
      for (let field of notifier.fields) {
        let fieldData = field;
        fieldData.value = ''; // has empty value to start
        notifierData.fields[field.name] = fieldData;
      }

      // build alerts
      for (let a in issueTypes) {
        notifierData.alerts[a] = true;
      }

      parliament.settings.notifiers[n] = notifierData;
    }
  }
}

function describeNotifierAlerts (settings) {
  for (let n in settings.notifiers) {
    const notifier = settings.notifiers[n];

    for (let a in notifier.alerts) {
      // describe alerts
      if (issueTypes.hasOwnProperty(a)) {
        const alert = JSON.parse(JSON.stringify(issueTypes[a]));
        alert.id = a;
        alert.on = notifier.alerts[a];
        notifier.alerts[a] = alert;
      }
    }
  }
}

// Initializes the parliament with ids for each group and cluster
// and sets up the parliament settings
function initializeParliament () {
  return new Promise((resolve, reject) => {
    if (!parliament.groups) { parliament.groups = []; }

    // set id for each group/cluster
    for (let group of parliament.groups) {
      group.id = groupId++;
      if (group.clusters) {
        for (let cluster of group.clusters) {
          cluster.id = clusterId++;
        }
      }
    }

    if (!parliament.settings) {
      parliament.settings = settingsDefault;
    }
    if (!parliament.settings.notifiers) {
      parliament.settings.notifiers = settingsDefault.notifiers;
    }
    if (!parliament.settings.general) {
      parliament.settings.general = settingsDefault.general;
    }
    if (!parliament.settings.general.outOfDate) {
      parliament.settings.general.outOfDate = settingsDefault.general.outOfDate;
    }
    if (!parliament.settings.general.esQueryTimeout) {
      parliament.settings.general.esQueryTimeout = settingsDefault.general.esQueryTimeout;
    }
    if (!parliament.settings.general.removeIssuesAfter) {
      parliament.settings.general.removeIssuesAfter = settingsDefault.general.removeIssuesAfter;
    }
    if (!parliament.settings.general.removeAcknowledgedAfter) {
      parliament.settings.general.removeAcknowledgedAfter = settingsDefault.general.removeAcknowledgedAfter;
    }

    // build notifiers
    for (let n in internals.notifiers) {
      // if the notifier is not in settings, add it
      if (!parliament.settings.notifiers[n]) {
        const notifier = internals.notifiers[n];

        let notifierData = { name: n, fields: {}, alerts: {} };

        // add fields to notifier
        for (let field of notifier.fields) {
          let fieldData = field;
          fieldData.value = ''; // has empty value to start
          notifierData.fields[field.name] = fieldData;
        }

        // build alerts
        for (let a in issueTypes) {
          notifierData.alerts[a] = true;
        }

        parliament.settings.notifiers[n] = notifierData;
      }
    }

    fs.writeFile(app.get('file'), JSON.stringify(parliament, null, 2), 'utf8',
      (err) => {
        if (err) {
          console.error('Parliament initialization error:', err.message || err);
          return reject(new Error('Parliament initialization error'));
        }

        return resolve();
      }
    );
  });
}

// Chains all promises for requests for health and stats to update each cluster
// in the parliament
function updateParliament () {
  return new Promise((resolve, reject) => {
    let promises = [];
    for (let group of parliament.groups) {
      if (group.clusters) {
        for (let cluster of group.clusters) {
          // only get health for online clusters
          if (!cluster.disabled) {
            promises.push(getHealth(cluster));
          }
          // don't get stats for multiviewers or offline clusters
          if (!cluster.multiviewer && !cluster.disabled) {
            promises.push(getStats(cluster));
          }
        }
      }
    }

    let issuesRemoved = cleanUpIssues();

    Promise.all(promises)
      .then(() => {
        if (issuesRemoved) { // save the issues that were removed
          fs.writeFile(app.get('issuesfile'), JSON.stringify(issues, null, 2), 'utf8',
            (err) => {
              if (err) {
                console.error('Unable to write issue:', err.message || err);
              }
            }
          );
        }
        // save the data created after updating the parliament
        fs.writeFile(app.get('file'), JSON.stringify(parliament, null, 2), 'utf8',
          (err) => {
            if (err) {
              console.error('Parliament update error:', err.message || err);
              return reject(new Error('Parliament update error'));
            }

            return resolve();
          });
        return resolve();
      })
      .catch((error) => {
        console.error('Parliament update error:', error.messge || error);
        return resolve();
      });
  });
}

function cleanUpIssues () {
  let issuesRemoved = false;

  let len = issues.length;
  while (len--) {
    const issue = issues[len];
    const timeSinceLastNoticed = Date.now() - issue.lastNoticed || issue.firstNoticed;
    const removeIssuesAfter = getGeneralSetting('removeIssuesAfter') * 1000 * 60;
    const removeAcknowledgedAfter = getGeneralSetting('removeAcknowledgedAfter') * 1000 * 60;

    // remove all issues that have not been seen again for the removeIssuesAfter time, and
    // remove all acknowledged issues that have not been seen again for the removeAcknowledgedAfter time
    if ((!issue.acknowledged && timeSinceLastNoticed > removeIssuesAfter) ||
        (issue.acknowledged && timeSinceLastNoticed > removeAcknowledgedAfter)) {
      issuesRemoved = true;
      issues.splice(len, 1);
    }

    // if the issue was acknowledged but still persists, unacknowledge and alert again
    if (issue.acknowledged && (Date.now() - issue.acknowledged) > removeAcknowledgedAfter) {
      issue.alerted = undefined;
      issue.acknowledged = undefined;
    }
  }

  return issuesRemoved;
}

function getGeneralSetting (type) {
  let val = settingsDefault.general[type];
  if (parliament.settings && parliament.settings.general && parliament.settings.general[type]) {
    val = parliament.settings.general[type];
  }
  return val;
}

// Writes the parliament to the parliament json file, updates the parliament
// with health and stats, then sends success or error
function writeParliament (req, res, next, successObj, errorText, sendParliament) {
  fs.writeFile(app.get('file'), JSON.stringify(parliament, null, 2), 'utf8',
    (err) => {
      if (err) {
        const errorMsg = `Unable to write parliament data: ${err.message || err}`;
        console.error(errorMsg);
        const error = new Error(errorMsg);
        error.httpStatusCode = 500;
        return next(error);
      }

      updateParliament()
        .then(() => {
          // send the updated parliament with the response
          if (sendParliament && successObj.parliament) {
            successObj.parliament = parliament;
          }
          return res.json(successObj);
        })
        .catch((err) => {
          const error = new Error(errorText || 'Error updating parliament.');
          error.httpStatusCode = 500;
          return next(error);
        });
    }
  );
}

// Writes the issues to the issues json file then sends success or error
function writeIssues (req, res, next, successObj, errorText, sendIssues) {
  fs.writeFile(app.get('issuesfile'), JSON.stringify(issues, null, 2), 'utf8',
    (err) => {
      if (err) {
        const errorMsg = `Unable to write issue data: ${err.message || err}`;
        console.error(errorMsg);
        const error = new Error(errorMsg);
        error.httpStatusCode = 500;
        return next(error);
      }

      // send the updated issues with the response
      if (sendIssues && successObj.issues) {
        successObj.issues = issues;
      }

      return res.json(successObj);
    }
  );
}

/* APIs -------------------------------------------------------------------- */
// Authenticate user
router.post('/auth', (req, res, next) => {
  let hasAuth = !!app.get('password');
  if (!hasAuth) {
    const error = new Error('No password set.');
    error.httpStatusCode = 401;
    return next(error);
  }

  // check if password matches
  if (!bcrypt.compareSync(req.body.password, app.get('password'))) {
    const error = new Error('Authentication failed.');
    error.httpStatusCode = 401;
    return next(error);
  }

  const payload = { admin:true };

  let token = jwt.sign(payload, app.get('password'), {
    expiresIn: 60 * 60 * 24 // expires in 24 hours
  });

  res.json({ // return the information including token as JSON
    success : true,
    text    : 'Here\'s your token!',
    token   : token
  });
});

// Get whether authentication is set
router.get('/auth', (req, res, next) => {
  let hasAuth = !!app.get('password');
  return res.json({ hasAuth:hasAuth });
});

// Get whether the user is logged in
// If it passes the verifyToken middleware, the user is logged in
router.get('/auth/loggedin', verifyToken, (req, res, next) => {
  return res.json({ loggedin:true });
});

// Update (or create) a password for the parliament
router.put('/auth/update', (req, res, next) => {
  if (!req.body.newPassword) {
    const error = new Error('You must provide a new password');
    error.httpStatusCode = 422;
    return next(error);
  }

  let hasAuth = !!app.get('password');
  if (hasAuth) { // if the user has a password already set
    // check if the user has supplied their current password
    if (!req.body.currentPassword) {
      const error = new Error('You must provide your current password');
      error.httpStatusCode = 401;
      return next(error);
    }
    // check if password matches
    if (!bcrypt.compareSync(req.body.currentPassword, app.get('password'))) {
      const error = new Error('Authentication failed.');
      error.httpStatusCode = 401;
      return next(error);
    }
  }

  bcrypt.hash(req.body.newPassword, saltrounds, (err, hash) => {
    if (err) {
      console.error(`Error hashing password: ${err}`);
      const error = new Error('Hashing password failed.');
      error.httpStatusCode = 401;
      return next(error);
    }

    app.set('password', hash);

    parliament.password = hash;

    const payload = { admin:true };

    let token = jwt.sign(payload, hash, {
      expiresIn: 60 * 60 * 24 // expires in 24 hours
    });

    // return the information including token as JSON
    let successObj  = { success: true, text: 'Here\'s your new token!', token: token };
    let errorText   = 'Unable to update your password.';
    writeParliament(req, res, next, successObj, errorText);
  });
});

// Get the parliament settings object
router.get('/settings', verifyToken, (req, res, next) => {
  if (!parliament.settings) {
    const error = new Error('Your settings are empty. Try restarting Parliament.');
    error.httpStatusCode = 500;
    return next(error);
  }

  let settings = JSON.parse(JSON.stringify(parliament.settings));

  if (!settings.general) {
    settings.general = settingsDefault.general;
  }

  describeNotifierAlerts(settings);

  return res.json(settings);
});

// Update the parliament settings object
router.put('/settings', verifyToken, (req, res, next) => {
  // save notifiers
  for (let n in req.body.settings.notifiers) {
    const notifier = req.body.settings.notifiers[n];
    let savedNotifiers = parliament.settings.notifiers;

    // notifier exists in settings, so update notifier and the fields
    if (savedNotifiers[notifier.name]) {
      savedNotifiers[notifier.name].on = !!notifier.on;

      for (let f in notifier.fields) {
        const field = notifier.fields[f];
        // notifier has field
        if (savedNotifiers[notifier.name].fields[field.name]) {
          savedNotifiers[notifier.name].fields[field.name].value = field.value;
        } else { // notifier does not have field
          const error = new Error('Unable to find notifier field to update.');
          error.httpStatusCode = 500;
          return next(error);
        }
      }

      for (let a in notifier.alerts) {
        const alert = notifier.alerts[a];
        // alert exists in settings, so update value
        if (savedNotifiers[notifier.name].alerts.hasOwnProperty(alert.id)) {
          savedNotifiers[notifier.name].alerts[alert.id] = alert.on;
        } else { // alert doesn't exist on this notifier
          const error = new Error('Unable to find alert to update.');
          error.httpStatusCode = 500;
          return next(error);
        }
      }
    } else { // notifier doesn't exist
      const error = new Error('Unable to find notifier. Is it loaded?');
      error.httpStatusCode = 500;
      return next(error);
    }
  }

  // save general settings
  for (let s in req.body.settings.general) {
    const setting = req.body.settings.general[s];
    if (isNaN(setting)) {
      const error = new Error(`${s} must be a number.`);
      error.httpStatusCode = 422;
      return next(error);
    }
    parliament.settings.general[s] = parseInt(setting);
  }

  let successObj  = { success: true, text: 'Successfully updated your settings.' };
  let errorText   = 'Unable to update your settings.';
  writeParliament(req, res, next, successObj, errorText);
});

// Update the parliament settings object to the defaults
router.put('/settings/restoreDefaults', verifyToken, (req, res, next) => {
  let type = 'all'; // default
  if (req.body.type) {
    type = req.body.type;
  }

  if (type === 'general') {
    parliament.settings.general = JSON.parse(JSON.stringify(settingsDefault.general));
  } else {
    parliament.settings = JSON.parse(JSON.stringify(settingsDefault));
  }

  buildNotifiers();

  let settings = JSON.parse(JSON.stringify(parliament.settings));
  describeNotifierAlerts(settings);

  fs.writeFile(app.get('file'), JSON.stringify(parliament, null, 2), 'utf8',
    (err) => {
      if (err) {
        const errorMsg = `Unable to write parliament data: ${err.message || err}`;
        console.error(errorMsg);
        const error = new Error(errorMsg);
        error.httpStatusCode = 500;
        return next(error);
      }

      return res.json({
        settings: settings,
        text: `Successfully restored ${req.body.type} default settings.`
      });
    }
  );
});

// Get parliament with stats
router.get('/parliament', (req, res, next) => {
  let parliamentClone = JSON.parse(JSON.stringify(parliament));

  for (const group of parliamentClone.groups) {
    for (let cluster of group.clusters) {
      cluster.activeIssues = [];
      for (let issue of issues) {
        if (issue.clusterId === cluster.id &&
          !issue.acknowledged && !issue.ignoreUntil) {
          cluster.activeIssues.push(issue);
        }
      }
    }
  }

  delete parliamentClone.settings;
  delete parliamentClone.password;

  return res.json(parliamentClone);
});

// Updates the parliament order of clusters and groups
router.put('/parliament', verifyToken, (req, res, next) => {
  if (!req.body.reorderedParliament) {
    const error = new Error('You must provide the new parliament order');
    error.httpStatusCode = 422;
    return next(error);
  }

  // remove any client only stuff
  for (const group of req.body.reorderedParliament.groups) {
    group.filteredClusters = undefined;
    for (const cluster of group.clusters) {
      cluster.issues = undefined;
      cluster.activeIssues = undefined;
    }
  }

  parliament = req.body.reorderedParliament;
  updateParliament();

  let successObj  = { success: true, text: 'Successfully reordered items in your parliament.' };
  let errorText   = 'Unable to update the order of items in your parliament.';
  writeParliament(req, res, next, successObj, errorText);
});

// Create a new group in the parliament
router.post('/groups', verifyToken, (req, res, next) => {
  if (!req.body.title) {
    const error = new Error('A group must have a title');
    error.httpStatusCode = 422;
    return next(error);
  }

  let newGroup = { title:req.body.title, id:groupId++, clusters:[] };
  if (req.body.description) { newGroup.description = req.body.description; }

  parliament.groups.push(newGroup);

  let successObj  = { success:true, group:newGroup, text: 'Successfully added new group.' };
  let errorText   = 'Unable to add that group to your parliament.';
  writeParliament(req, res, next, successObj, errorText);
});

// Delete a group in the parliament
router.delete('/groups/:id', verifyToken, (req, res, next) => {
  let index = 0;
  let foundGroup = false;
  for (let group of parliament.groups) {
    if (group.id === parseInt(req.params.id)) {
      parliament.groups.splice(index, 1);
      foundGroup = true;
      break;
    }
    ++index;
  }

  if (!foundGroup) {
    const error = new Error('Unable to find group to delete.');
    error.httpStatusCode = 500;
    return next(error);
  }

  let successObj  = { success:true, text:'Successfully removed the requested group.' };
  let errorText   = 'Unable to remove that group from the parliament.';
  writeParliament(req, res, next, successObj, errorText);
});

// Update a group in the parliament
router.put('/groups/:id', verifyToken, (req, res, next) => {
  if (!req.body.title) {
    const error = new Error('A group must have a title.');
    error.httpStatusCode = 422;
    return next(error);
  }

  let foundGroup = false;
  for (let group of parliament.groups) {
    if (group.id === parseInt(req.params.id)) {
      group.title = req.body.title;
      if (req.body.description) {
        group.description = req.body.description;
      }
      foundGroup = true;
      break;
    }
  }

  if (!foundGroup) {
    const error = new Error('Unable to find group to edit.');
    error.httpStatusCode = 500;
    return next(error);
  }

  let successObj  = { success:true, text:'Successfully updated the requested group.' };
  let errorText   = 'Unable to update that group in the parliament.';
  writeParliament(req, res, next, successObj, errorText);
});

// Create a new cluster within an existing group
router.post('/groups/:id/clusters', verifyToken, (req, res, next) => {
  if (!req.body.title || !req.body.url) {
    let message;
    if (!req.body.title) {
      message = 'A cluster must have a title.';
    } else if (!req.body.url) {
      message = 'A cluster must have a url.';
    }

    const error = new Error(message);
    error.httpStatusCode = 422;
    return next(error);
  }

  let newCluster = {
    title       : req.body.title,
    description : req.body.description,
    url         : req.body.url,
    localUrl    : req.body.localUrl,
    multiviewer : req.body.multiviewer,
    disabled    : req.body.disabled,
    id          : clusterId++
  };

  let foundGroup = false;
  for (let group of parliament.groups) {
    if (group.id === parseInt(req.params.id)) {
      group.clusters.push(newCluster);
      foundGroup = true;
      break;
    }
  }

  if (!foundGroup) {
    const error = new Error('Unable to find group to place cluster.');
    error.httpStatusCode = 500;
    return next(error);
  }

  let successObj  = {
    success   : true,
    cluster   : newCluster,
    parliament: parliament,
    text      : 'Successfully added the requested cluster.'
  };
  let errorText   = 'Unable to add that cluster to the parliament.';
  writeParliament(req, res, next, successObj, errorText, true);
});

// Delete a cluster
router.delete('/groups/:groupId/clusters/:clusterId', verifyToken, (req, res, next) => {
  let clusterIndex = 0;
  let foundCluster = false;
  for (let group of parliament.groups) {
    if (group.id === parseInt(req.params.groupId)) {
      for (let cluster of group.clusters) {
        if (cluster.id === parseInt(req.params.clusterId)) {
          group.clusters.splice(clusterIndex, 1);
          foundCluster = true;
          break;
        }
        ++clusterIndex;
      }
    }
  }

  if (!foundCluster) {
    const error = new Error('Unable to find cluster to delete.');
    error.httpStatusCode = 500;
    return next(error);
  }

  let successObj  = { success:true, text: 'Successfully removed the requested cluster.' };
  let errorText   = 'Unable to remove that cluster from your parliament.';
  writeParliament(req, res, next, successObj, errorText);
});

// Update a cluster
router.put('/groups/:groupId/clusters/:clusterId', verifyToken, (req, res, next) => {
  if (!req.body.title || !req.body.url) {
    let message;
    if (!req.body.title) {
      message = 'A cluster must have a title.';
    } else if (!req.body.url) {
      message = 'A cluster must have a url.';
    }

    const error = new Error(message);
    error.httpStatusCode = 422;
    return next(error);
  }

  let foundCluster = false;
  for (let group of parliament.groups) {
    if (group.id === parseInt(req.params.groupId)) {
      for (let cluster of group.clusters) {
        if (cluster.id === parseInt(req.params.clusterId)) {
          cluster.title           = req.body.title;
          cluster.description     = req.body.description;
          cluster.url             = req.body.url;
          cluster.localUrl        = req.body.localUrl;
          cluster.multiviewer     = req.body.multiviewer;
          cluster.disabled        = req.body.disabled;
          cluster.hideDeltaBPS    = req.body.hideDeltaBPS;
          cluster.hideDataNodes   = req.body.hideDataNodes;
          cluster.hideDeltaTDPS   = req.body.hideDeltaTDPS;
          cluster.hideTotalNodes  = req.body.hideTotalNodes;
          foundCluster = true;
          break;
        }
      }
    }
  }

  if (!foundCluster) {
    const error = new Error('Unable to find cluster to update.');
    error.httpStatusCode = 500;
    return next(error);
  }

  let successObj  = { success: true, text: 'Successfully updated the requested cluster.' };
  let errorText   = 'Unable to update that cluster in your parliament.';
  writeParliament(req, res, next, successObj, errorText);
});

// Get a list of issues
router.get('/issues', (req, res, next) => {
  let issuesClone = JSON.parse(JSON.stringify(issues));

  let type = 'string';
  let sortBy = req.query.sort;
  if (sortBy === 'ignoreUntil' ||
    sortBy === 'firstNoticed' ||
    sortBy === 'lastNoticed' ||
    sortBy === 'acknowledged') {
    type = 'number';
  }

  if (sortBy) {
    let order = req.query.order || 'desc';
    issuesClone.sort((a, b) => {
      if (type === 'string') {
        let aVal = '';
        let bVal = '';

        if (b[sortBy] !== undefined) { bVal = b[sortBy]; }
        if (a[sortBy] !== undefined) { aVal = a[sortBy]; }

        return order === 'asc' ? bVal.localeCompare(aVal) : aVal.localeCompare(bVal);
      } else if (type === 'number') {
        let aVal = 0;
        let bVal = 0;

        if (b[sortBy] !== undefined) { bVal = b[sortBy]; }
        if (a[sortBy] !== undefined) { aVal = a[sortBy]; }

        return order === 'asc' ? bVal - aVal : aVal - bVal;
      }
    });
  }

  return res.json({ issues: issuesClone });
});

// acknowledge one or more issues
router.put('/acknowledgeIssues', verifyToken, (req, res, next) => {
  if (!req.body.issues || !req.body.issues.length) {
    let message = 'Must specify the issue(s) to acknowledge.';
    const error = new Error(message);
    error.httpStatusCode = 422;
    return next(error);
  }

  let now = Date.now();
  let count = 0;

  for (let i of req.body.issues) {
    let issue = findIssue(parseInt(i.clusterId), i.type, i.node);
    if (issue) {
      issue.acknowledged = now;
      count++;
    }
  }

  if (!count) {
    let errorText = 'Unable to acknowledge requested issue';
    if (req.body.issues.length > 1) { errorText += 's'; }
    const error = new Error(errorText);
    error.httpStatusCode = 500;
    return next(error);
  }

  let successText = `Successfully acknowledged ${count} requested issue`;
  let errorText = 'Unable to acknowledge the requested issue';
  if (count > 1) {
    successText += 's';
    errorText += 's';
  }

  let successObj = { success:true, text:successText, acknowledged:now };
  writeIssues(req, res, next, successObj, errorText);
});

// ignore one or more issues
router.put('/ignoreIssues', verifyToken, (req, res, next) => {
  if (!req.body.issues || !req.body.issues.length) {
    let message = 'Must specify the issue(s) to ignore.';
    const error = new Error(message);
    error.httpStatusCode = 422;
    return next(error);
  }

  let ms = req.body.ms || 3600000; // Default to 1 hour
  let ignoreUntil = Date.now() + ms;
  if (ms === -1) { ignoreUntil = -1; } // -1 means ignore it forever

  let count = 0;

  for (let i of req.body.issues) {
    let issue = findIssue(parseInt(i.clusterId), i.type, i.node);
    if (issue) {
      issue.ignoreUntil = ignoreUntil;
      count++;
    }
  }

  if (!count) {
    let errorText = 'Unable to ignore requested issue';
    if (req.body.issues.length > 1) { errorText += 's'; }
    const error = new Error(errorText);
    error.httpStatusCode = 500;
    return next(error);
  }

  let successText = `Successfully ignored ${count} requested issue`;
  let errorText = 'Unable to ignore the requested issue';
  if (count > 1) {
    successText += 's';
    errorText += 's';
  }

  let successObj = { success:true, text:successText, ignoreUntil:ignoreUntil };
  writeIssues(req, res, next, successObj, errorText);
});

// unignore one or more issues
router.put('/removeIgnoreIssues', verifyToken, (req, res, next) => {
  if (!req.body.issues || !req.body.issues.length) {
    let message = 'Must specify the issue(s) to unignore.';
    const error = new Error(message);
    error.httpStatusCode = 422;
    return next(error);
  }

  let count = 0;

  for (let i of req.body.issues) {
    let issue = findIssue(parseInt(i.clusterId), i.type, i.node);
    if (issue) {
      issue.ignoreUntil = undefined;
      issue.alerted     = undefined; // reset alert time so it can alert again
      count++;
    }
  }

  if (!count) {
    let errorText = 'Unable to unignore requested issue';
    if (req.body.issues.length > 1) { errorText += 's'; }
    const error = new Error(errorText);
    error.httpStatusCode = 500;
    return next(error);
  }

  let successText = `Successfully unignored ${count} requested issue`;
  let errorText = 'Unable to unignore the requested issue';
  if (count > 1) {
    successText += 's';
    errorText += 's';
  }

  let successObj = { success:true, text:successText };
  writeIssues(req, res, next, successObj, errorText);
});

// Remove an issue with a cluster
router.put('/groups/:groupId/clusters/:clusterId/removeIssue', verifyToken, (req, res, next) => {
  if (!req.body.type) {
    let message = 'Must specify the issue type to remove.';
    const error = new Error(message);
    error.httpStatusCode = 422;
    return next(error);
  }

  let foundIssue = false;
  let len = issues.length;
  while (len--) {
    const issue = issues[len];
    if (issue.clusterId === parseInt(req.params.clusterId) &&
      issue.type === req.body.type &&
      issue.node === req.body.node) {
      foundIssue = true;
      issues.splice(len, 1);
    }
  }

  if (!foundIssue) {
    const error = new Error('Unable to find issue to remove. Maybe it was already removed.');
    error.httpStatusCode = 500;
    return next(error);
  }

  let successObj  = { success:true, text:'Successfully removed the requested issue.' };
  let errorText   = 'Unable to remove that issue.';
  writeIssues(req, res, next, successObj, errorText);
});

// Remove all acknowledged all issues
router.put('/issues/removeAllAcknowledgedIssues', verifyToken, (req, res, next) => {
  let count = 0;

  let len = issues.length;
  while (len--) {
    const issue = issues[len];
    if (issue.acknowledged) {
      count++;
      issues.splice(len, 1);
    }
  }

  if (!count) {
    const error = new Error('There are no acknowledged issues to remove.');
    error.httpStatusCode = 400;
    return next(error);
  }

  let successObj  = { success:true, text:`Successfully removed ${count} acknowledged issues.`, issues:issues };
  let errorText   = 'Unable to remove acknowledged issues.';
  writeIssues(req, res, next, successObj, errorText, true);
});

// issue a test alert to a specified notifier
router.post('/testAlert', (req, res, next) => {
  if (!req.body.notifier) {
    const error = new Error('Must specify the notifier.');
    error.httpStatusCode = 422;
    return next(error);
  }

  for (let n in internals.notifiers) {
    if (n !== req.body.notifier) { continue; }

    const notifier = internals.notifiers[n];

    let config = {};

    for (let f of notifier.fields) {
      let field = parliament.settings.notifiers[n].fields[f.name];
      if (!field || (field.required && !field.value)) {
        // field doesn't exist, or field is required and doesn't have a value
        let message = `Missing the ${field.name} field for ${n} alerting. Add it on the settings page.`;
        console.error(message);

        const error = new Error(message);
        error.httpStatusCode = 422;
        return next(error);
      }
      config[f.name] = field.value;
    }

    notifier.sendAlert(config, 'Test alert');
  }

  let successObj  = { success:true, text:`Successfully issued alert using the ${req.body.notifier} notifier.` };
  let errorText   = `Unable to issue alert using the ${req.body.notifier} notifier.`;
  writeParliament(req, res, next, successObj, errorText);
});

/* SIGNALS! ----------------------------------------------------------------- */
// Explicit sigint handler for running under docker
// See https://github.com/nodejs/node/issues/4182
process.on('SIGINT', function () {
  process.exit();
});

/* LISTEN! ----------------------------------------------------------------- */
// vue index page
app.use((req, res, next) => {
  res.status(404).sendFile(`${__dirname}/vueapp/dist/index.html`);
});

let server;
if (app.get('keyFile') && app.get('certFile')) {
  const certOptions = {
    key : fs.readFileSync(app.get('keyFile')),
    cert: fs.readFileSync(app.get('certFile'))
  };
  server = https.createServer(certOptions, app);
} else {
  server = http.createServer(app);
}

server
  .on('error', function (e) {
    console.error(`ERROR - couldn't listen on port ${app.get('port')}, is Parliament already running?`);
    process.exit(1);
  })
  .on('listening', function (e) {
    console.log(`Express server listening on port ${server.address().port} in ${app.settings.env} mode`);
  })
  .listen(app.get('port'), () => {
    initializeParliament()
      .then(() => {
        updateParliament();
      })
      .catch(() => {
        console.error(`ERROR - couldn't initialize Parliament`);
        process.exit(1);
      });

    setInterval(() => {
      updateParliament();
      processAlerts();
    }, 10000);
  });
