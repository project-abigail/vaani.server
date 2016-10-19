/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

'use strict';

const fs = require('fs');
const path = require('path');
const stream = require('stream');
const process = require('process');
const google_rs = require('./google_rs');
const userNames = require('../../user-names.json');

const phraseHints = [];
userNames.forEach((userName) => {
  phraseHints.push(`Remind ${userName}`);
  phraseHints.push(userName);
});

exports.speech_to_text = (config) => {
  return {
    recognize: (params, callback) => {
      const problem = (err) => callback(err, null);

      const getBestHypothesis = (results) => {
        const result = { confidence: 0, transcript: '' };

        for (const i in results) {
          if (true == results[i].isFinal) {
            const alternatives = results[i].alternatives;
            for (const j in alternatives) {
              const alternative = alternatives[j];
              if (result.confidence < alternative.confidence) {
                result.confidence = alternative.confidence;
                result.transcript = alternative.transcript.trim();
              }
            }
          }
        }

        return result;
      };

      const doRecognition = () => {
        google_rs.getSpeechService(config.host)
          .then((speechService) => {
            const speech_to_text = speechService.streamingRecognize();
            let results = [];

            speech_to_text.on('error', problem);
            speech_to_text.on('data', (res) => results = results.concat(res.results));
            speech_to_text.on('end', () => callback(null, getBestHypothesis(results)));
            speech_to_text.write({
              streamingConfig: {
                config: {
                  encoding: 'LINEAR16',
                  sampleRate: 16000,
                  languageCode: 'en-US',
                  speechContext: {
                    phrases: phraseHints,
                  },
                },
                interimResults: false,
                singleUtterance: true
              }
            });

            const toRecognizeRequest = new stream.Transform({ objectMode: true });
            toRecognizeRequest._transform =
              (chunk, encoding, done) => done(null, { audioContent: chunk });
            params.audio.pipe(toRecognizeRequest).pipe(speech_to_text);
          })
          .catch(problem);
      };

      if (config._written) {
        doRecognition();
      } else {
        const configPath = process.env['GOOGLE_APPLICATION_CREDENTIALS'] =
          path.join(__dirname, '..', '..', '.google.json');
        process.env['GCLOUD_PROJECT'] = config.GCLOUD_PROJECT;
        fs.writeFile(configPath, JSON.stringify(config), (err) => {
          if (err) {
            problem(err);
          } else {
            config._written = true;
            doRecognition();
          }
        });
      }
    }
  }
};
