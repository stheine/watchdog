#!/usr/bin/env node

'use strict';

const os          = require('os');

const dayjs       = require('dayjs');
const express     = require('express');
const millisecond = require('millisecond');
const mqtt        = require('async-mqtt');
const needle      = require('needle');
const nodemailer  = require('nodemailer');

const logger      = require('./logger');

const hostname = os.hostname();
const servers  = [
  'pi-jalousie',
  'pi-wecker',
  'qnap',
];

// ###########################################################################
// Globals

let mqttClient;

// ###########################################################################
// Process handling

const stopProcess = async function() {
  if(mqttClient) {
    await mqttClient.end();
    mqttClient = undefined;
  }

  logger.info(`Shutdown -------------------------------------------------`);

  process.exit(0);
};

process.on('SIGINT',  () => stopProcess());
process.on('SIGTERM', () => stopProcess());

// #############################################################################
// Monitor remote servers
const checkServers = async function() {
  const errors = [];

  for(const server of servers) {
    if(hostname === `${server}-watchdog`) {
      // logger.info(`Skipping ${server}`);

      continue;
    }

//    logger.info(`Checking ${server}`);

    try {
      const result = await needle(`http://${server}.fritz.box:31038/health`);

//      logger.info(`Got ${server}`, result.body);

      if(result.body !== 'ok') {
//        logger.error(`Server unhealthy ${server}: ${result.body}`);

        errors.push(`Server unhealthy ${server}: ${result.body}`);
      }
    } catch(err) {
//      logger.error(`Server down ${server}: ${err.message}`);

      errors.push(`Server down ${server}: ${err.message}`);
    }
  }

  if(errors.length) {
    try {
      const transport = nodemailer.createTransport({
        host:   'postfix',
        port:   25,
        secure: false,
        tls:    {rejectUnauthorized: false},
      });

      await transport.sendMail({
        to:      'stefan@heine7.de',
        subject: `Watchdog warning ${hostname}`,
        html:    `
          <p>Watchdog on ${hostname} detected remote server issues:</p>
          <p><pre>${errors.join('\n')}</pre></p>
        `,
      });
    } catch(err) {
      logger.error(`Failed to send error mail: ${err.message}`);
    }
  }
};

// ###########################################################################
// Main

(async() => {
  // #########################################################################
  // Startup

  logger.info(`Startup watchdog on ${hostname} ------------------------------------`);

  // #########################################################################
  // Start server

  const app = express();

  app.get('/health', (res, req) => {
    req.send('ok');
  });

  app.listen(31038);

  logger.info('Listening');

  // #########################################################################
  // Start monitor loop

  await checkServers();

  setInterval(checkServers, millisecond('15 minutes'));

  // #########################################################################
  // Start MQTT monitoring
  if(hostname === 'qnap-watchdog') {
    const notified = {};
    const timeout = {};

    logger.info(`Start MQTT monitoring`);

    mqttClient = await mqtt.connectAsync('tcp://192.168.6.7:1883');

    mqttClient.on('message', async(topic, messageBuffer) => {
      const messageRaw = messageBuffer.toString();

      try {
        let message;

        try {
          message = JSON.parse(messageRaw);
        } catch(err) {
          // ignore
        }

        const matches = topic.match(/^tasmota\/([^/]+)\/tele\/LWT$/);

        if(matches) {
          const sender = matches[1];

          if(sender === 'steckdose') {
            return;
          }

          if(messageRaw === 'Offline') {
            if(timeout[sender]) {
              // logger.warn(`${messageRaw} ${sender} timer already running`);
            } else {
              // logger.info(`${messageRaw} ${sender} timer start`);
              timeout[sender] = setTimeout(async() => {
                logger.info(`${messageRaw} ${sender} timer trigger notification`);

                try {
                  const transport = nodemailer.createTransport({
                    host:   'postfix',
                    port:   25,
                    secure: false,
                    tls:    {rejectUnauthorized: false},
                  });

                  await transport.sendMail({
                    to:      'stefan@heine7.de',
                    subject: 'Watchdog MQTT device down',
                    html:    `
                      <p>Watchdog on ${hostname} detected MQTT device down:</p>
                      <p><pre>${sender} ${messageRaw}</pre></p>
                    `,
                  });

                  notified[sender] = true;
                } catch(err) {
                  logger.error(`Failed to send error mail: ${err.message}`);
                }
              }, millisecond('20 minutes'));
            }
          } else {
            if(timeout[sender]) {
              // logger.info(`${messageRaw} ${sender} clear timer`);
              clearTimeout(timeout[sender]);
              Reflect.deleteProperty(timeout, sender);
            }

            if(notified[sender]) {
              try {
                const transport = nodemailer.createTransport({
                  host:   'postfix',
                  port:   25,
                  secure: false,
                  tls:    {rejectUnauthorized: false},
                });

                await transport.sendMail({
                  to:      'stefan@heine7.de',
                  subject: 'Watchdog MQTT device back up',
                  html:    `
                    <p>Watchdog on ${hostname} detected MQTT device back up:</p>
                    <p><pre>${sender} ${messageRaw}</pre></p>
                  `,
                });

                Reflect.deleteProperty(notified, sender);
              } catch(err) {
                logger.error(`Failed to send error mail: ${err.message}`);
              }
            }
          }
        }
      } catch(err) {
        logger.error(`Failed mqtt handling for '${topic}': ${messageRaw}`, err);
      }
    });

    await mqttClient.subscribe('tasmota/#');
  }
})();
