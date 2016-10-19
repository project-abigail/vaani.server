// Copyright 2016, Google, Inc.
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//    http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

'use strict';

const path = require('path');
const grpc = require('grpc');
const googleAuth = require('google-auto-auth');
const googleProtoFiles = require('google-proto-files');

const PROTO_ROOT_DIR = googleProtoFiles('..');

const protoDescriptor = grpc.load({
  root: PROTO_ROOT_DIR,
  file: path.relative(PROTO_ROOT_DIR, googleProtoFiles.speech.v1beta1),
}, 'proto', {
  binaryAsBase64: true,
  convertFieldsToCamelCase: true,
});

const speechProto = protoDescriptor.google.cloud.speech.v1beta1;

const getSpeechService = (host) => {
  // Create a promise to get SpeechService.
  return new Promise((resolve, reject) => {
    const googleAuthClient = googleAuth({
      scopes: [
        'https://www.googleapis.com/auth/cloud-platform',
      ],
    });

    googleAuthClient.getAuthClient((err, authClient) => {
      if (err) {
        return reject(err);
      }

      const credentials = grpc.credentials.combineChannelCredentials(
        grpc.credentials.createSsl(),
        grpc.credentials.createFromGoogleCredential(authClient)
      );
      const speech = new speechProto.Speech(host, credentials);

      resolve(speech);
    });
  });
};

module.exports.getSpeechService = getSpeechService;
