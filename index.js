/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

'use strict';

const fs = require('fs');
const url = require('url');
const path = require('path');
const http = require('http');
const https = require('https');
const stream = require('stream');
const express = require('express');
const shortid = require('shortid');
const WebSocketServer = require('ws').Server;
const stt = require('./lib/stt');
const watson = require('watson-developer-cloud');
const fetch = require('node-fetch');
const IntentParser = require('intent-parser');

const sorryUnderstand = 'I did not understand that. Can you repeat?';
const sorryService = 'Sorry, the service is not available at the moment.';
const sorryNetwork = 'Sorry, I was not able to save this reminder.';
const unknown = '<unknown>';

const OK = 0;
const ERROR_PARSING = 1;
const ERROR_EXECUTING = 2;
const ERROR_SAVING = 3;
const ERROR_STT = 100;

const logdir = './log/';
const ssldir = './resources/ssl/';

if (!fs.existsSync(logdir)) {
  fs.mkdirSync(logdir);
}

const getConfig = () => {
  var config = JSON.parse(process.env.VAANI_CONFIG || fs.readFileSync("config.json"));
  config.secure = !!config.secure;
  config.port = process.env.PORT || config.port || (config.secure ? 443 : 80);
  config.maxwords = config.maxwords || 5;
  return config;
};

const serve = (config, callback) => {
  config = config || getConfig();

  const log = s => console.log('T: ' + new Date().toISOString() + ' - ' + s);

  var server,
    clientcounter = 0;

  if (config.secure) {
    server = https.createServer({
      key: fs.readFileSync(ssldir + 'server-key.pem'),
      cert: fs.readFileSync(ssldir + 'server-crt.pem'),
      ca: fs.readFileSync(ssldir + 'ca-crt.pem'),
      passphrase: config.passphrase,
      requestCert: true,
      rejectUnauthorized: true
    });
  } else {
    server = http.createServer();
  }

  server.on('error', (error) => {
    log('server problem - ' + error.message);
    process.exit(1);
  });

  const app = express();
  app.use((req, res) => {
    //if (req.client.authorized) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{ "status": "approved" }');
    log('sending status approved');
    /*} else {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end('{ "status": "denied" }');
      log('sending status declined');
    }*/
  });
  server.on('request', app);

  server.listen(config.port);
  log('serving on port ' + config.port);

  const wss = new WebSocketServer({
    server: server
  });

  if (config.healthport) {
    http.createServer((req, res) => {
      res.end('I am alive!');
    }).listen(config.healthport);
    log('health status on port ' + config.port);
  }

  const speech_to_text = stt.speech_to_text(config.stt);
  const text_to_speech = watson.text_to_speech(config.tts.watson);

  wss.on('connection', (client) => {
    var clientindex = clientcounter++;
    const log = s => console.log(
      'T: ' + new Date().toISOString() + ' ' +
      'C: ' + clientindex + ' - ', s);

    var audio = new stream.PassThrough(),
      logfile = path.join(logdir, shortid.generate()),
      rawlog = fs.createWriteStream(logfile + '.raw'),
      query = url.parse(client.upgradeReq.url, true).query,
      sttParams = { audio: audio };
    const token = query.authtoken;

    const intentParser = new IntentParser();

    audio.on('error', err => log('problem passing audio - ' + err));
    rawlog.on('error', err => log('problem logging audio - ' + err));

    const writeToSinks = data => {
      audio.write(data);
      rawlog.write(data);
    };

    const closeSinks = () => {
      audio.end();
      rawlog.end();
    };

    const fail = (message) => {
      closeSinks();
      client.close();
      log('failed - ' + message);
    };

    const interpret = (command, confidence) => {
      console.log(command, confidence);

      // Some cleaning. Remove things like [SMACK], [COUGH] and such...
      command = command
        .replace(/\[\w+\]/g, '');

      const headers = {
        'Content-Type': 'application/json;charset=UTF-8',
        Authorization: `Bearer ${token}`,
      };
      let reminder = {};

      intentParser.parse(command)
        .then((res) => {
          console.log(res);

          reminder = res;

          return fetch('https://calendar.knilxof.org/api/v2/users/myself/relations',
            {
              headers,
            });
        })
        .then((res) => {
          if (!res.ok) {
            throw new Error('Cannot get the users id.');
          }

          return res.json();
        })
        .then((userObjs) => {
          // Get the id for the recipient of this reminder.
          const users = reminder.recipients.map((forename) => {
            let user = {};

            userObjs.some((userObj) => {
              if (userObj.forename.toLowerCase() === forename.toLowerCase()) {
                user = { id: userObj.id };
                return true;
              }
            });

            return user;
          });

          log('users');
          log(users);

          const body = JSON.stringify({
            recipients: users,
            action: reminder.action,
            due: reminder.due,
          });

          log('body');
          log(body);

          // Create the reminder on Cue server.
          return fetch('https://calendar.knilxof.org/api/v2/reminders',
            {
              method: 'POST',
              headers,
              body,
            })
            .then((res) => {
              if (!res.ok) {
                throw new Error('Cannot save the reminder');
              }

              log('Saving successful.');
            });
        })
        .then(() => {
          // @todo Implement the query case.
          answer(OK, reminder.confirmation, command, confidence);
        })
        .catch((err) => {
          if (!reminder) {
            log('problem interpreting - ' + command, err);
            answer(ERROR_PARSING, sorryUnderstand, command, confidence);
            return;
          }

          log('problem saving reminder - ', err);
          answer(ERROR_SAVING, sorryNetwork, err);
        });
    };

    const answer = (status, message, command, confidence) => {
      log('sending answer - ' + status + ' - ' + message);
      try {
        var jsonResult = JSON.stringify({
          status: status,
          message: message,
          command: command,
          confidence: confidence || 1
        });

        client.send(jsonResult);

        fs.writeFile(
          logfile + '.json',
          jsonResult,
          err => err && log("problem logging json - " + err)
        );

        var voice = text_to_speech.synthesize({
          text: [
            '<express-as type="',
            (status > 0 ? 'Apology' : ''),
            '">',
            message,
            '</express-as>'
          ].join(''),
          voice: 'en-US_AllisonVoice',
          accept: 'audio/wav'
        }, err => err ? fail('problem with TTS service - ' + err) : client.close());
        voice.on('data', data => (client.readyState == client.OPEN) && client.send(data));
        voice.on('end', () => client.close());
      } catch (ex) {
        fail('answering - ' + JSON.stringify(ex));
      }
    };

    client.on('error', err => fail('client connection' + err));
    client.on('message', data => data === 'EOS' ? closeSinks() : writeToSinks(data));

    speech_to_text.recognize(sttParams, (err, res) => {
        if (err) {
          log('problem STT - ' + err);
          answer(ERROR_STT, sorryService, unknown, 0);
        } else
          interpret(res.transcript, res.confidence);
      }
    );
  });

  callback && callback();
};

exports.getConfig = getConfig;
exports.serve = serve;
