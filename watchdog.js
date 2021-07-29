#!/usr/bin/env node

'use strict';

/* eslint-disable camelcase */
/* eslint-disable no-cond-assign */
/* eslint-disable prefer-named-capture-group */

const os          = require('os');

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

let   mqttClient;
let   lastStrom;
const notified = {};
const timeout  = {};


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
  for(const server of servers) {
    if(hostname === `${server}-watchdog`) {
      // logger.info(`Skipping ${server}`);

      continue;
    }

//    logger.info(`Checking ${server}`);

    let error;

    try {
      const result = await needle('get', `http://${server}.fritz.box:31038/health`, {
        open_timeout:     millisecond('5 seconds'),
        response_timeout: millisecond('5 seconds'),
        read_timeout:     millisecond('5 seconds'),
      });

//      logger.info(`Got ${server}`, result.body);

      if(result.body !== 'ok') {
        error = result.body;

        logger.error(`Server unhealthy ${server}: ${error}`);
      }
    } catch(err) {
      error = `Server unresponsive ${server}: ${err.message}`;

      logger.error(`Server down ${server}: ${error}`);
    }

    if(error) {
      if(timeout[server]) {
        // logger.warn(`${server} timer already running`);
      } else {
        logger.info(`${server} timer start: ${error}`);
        timeout[server] = setTimeout(async() => {
          logger.info(`${server} timer trigger notification: ${error}`);

          try {
            const transport = nodemailer.createTransport({
              host:   'postfix',
              port:   25,
              secure: false,
              tls:    {rejectUnauthorized: false},
            });

            await transport.sendMail({
              to:      'stefan@heine7.de',
              subject: `Watchdog server warning ${server} (${hostname})`,
              html:    `
                <p>Watchdog on ${hostname} detected remote server issues:</p>
                <p><pre>${error}</pre></p>
              `,
            });

            notified[server] = true;
          } catch(err) {
            logger.error(`Failed to send error mail: ${err.message}`);
          }
        }, millisecond('20 minutes'));
      }
    } else {
      if(timeout[server]) {
        logger.info(`${server} clear timer`);
        clearTimeout(timeout[server]);
        Reflect.deleteProperty(timeout, server);
      }

      if(notified[server]) {
        try {
          const transport = nodemailer.createTransport({
            host:   'postfix',
            port:   25,
            secure: false,
            tls:    {rejectUnauthorized: false},
          });

          await transport.sendMail({
            to:      'stefan@heine7.de',
            subject: `Watchdog server back up ${server} (${hostname})`,
            html:    `
              <p>Watchdog on ${hostname} back up:</p>
              <p><pre>${server}</pre></p>
            `,
          });

          Reflect.deleteProperty(notified, server);
        } catch(err) {
          logger.error(`Failed to send error mail: ${err.message}`);
        }
      }
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

  setInterval(checkServers, millisecond('1 minutes'));

  // #########################################################################
  // Start MQTT monitoring
  if(hostname === 'qnap-watchdog') {
    logger.info(`Start MQTT monitoring`);

    mqttClient = await mqtt.connectAsync('tcp://192.168.6.7:1883');

    mqttClient.on('message', async(topic, messageBuffer) => {
      const messageRaw = messageBuffer.toString();
      let   message;

      try {
        message = JSON.parse(messageRaw);
      } catch {
        // ignore
        message = {};
      }

      try {
        // logger.info(topic, messageRaw);

        if(topic.startsWith('Zigbee/')) {
          if(topic.startsWith('Zigbee/bridge')) {
            return;
          }

          const sender = topic.replace(/^Zigbee\//, '');
          const {battery} = message;

          if(battery < 50) {
            logger.warn(`${sender} battery=${battery}`);
          }

          // logger.info(topic, messageRaw);

          if(timeout[sender]) {
            clearTimeout(timeout[sender]);
          }

          timeout[sender] = setTimeout(async() => {
            logger.info(`${sender} timer trigger notification`);

            try {
              const transport = nodemailer.createTransport({
                host:   'postfix',
                port:   25,
                secure: false,
                tls:    {rejectUnauthorized: false},
              });

              await transport.sendMail({
                to:      'stefan@heine7.de',
                subject: `Watchdog Zigbee device inactive ${sender} (${hostname})`,
                html:    `
                  <p>Watchdog on ${hostname} detected Zigbee device inactive:</p>
                  <p><pre>${sender}</pre></p>
                `,
              });

              notified[sender] = true;
            } catch(err) {
              logger.error(`Failed to send error mail: ${err.message}`);
            }
          }, millisecond('15 hours'));

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
                subject: `Watchdog Zigbee device back up ${sender} (${hostname})`,
                html:    `
                  <p>Watchdog on ${hostname} detected Zigbee device back up:</p>
                  <p><pre>${sender}</pre></p>
                `,
              });

              Reflect.deleteProperty(notified, sender);
            } catch(err) {
              logger.error(`Failed to send error mail: ${err.message}`);
            }
          }
        } else if(topic === 'tasmota/espstrom/tele/SENSOR') {
          const sender       = 'espstrom';
          const currentStrom = `${message.SML.Verbrauch}:${message.SML.Leistung}`;

          if(lastStrom === currentStrom) {
            if(timeout[sender]) {
              logger.warn(`${sender} timer already running`, message);
            } else {
              logger.info(`${sender} timer start`, message);
              timeout[sender] = setTimeout(async() => {
                logger.info(`${sender} timer trigger notification`, message);

                try {
                  const transport = nodemailer.createTransport({
                    host:   'postfix',
                    port:   25,
                    secure: false,
                    tls:    {rejectUnauthorized: false},
                  });

                  await transport.sendMail({
                    to:      'stefan@heine7.de',
                    subject: `Watchdog MQTT device down ${sender} (${hostname})`,
                    html:    `
                      <p>Watchdog on ${hostname} detected MQTT device down:</p>
                      <p><pre>${sender} ${messageRaw}</pre></p>
                    `,
                  });

                  notified[sender] = true;
                } catch(err) {
                  logger.error(`Failed to send error mail: ${err.message}`);
                }
              }, millisecond('5 minutes'));
            }
          } else {
            if(timeout[sender]) {
              logger.info(`${sender} clear timer`, message);
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
                  subject: `Watchdog MQTT device back up ${sender} (${hostname})`,
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

            lastStrom = currentStrom;

            await mqttClient.publish(`tasmota/espstrom/cmnd/LedPower1`, '1');
            setTimeout(async() => {
              await mqttClient.publish(`tasmota/espstrom/cmnd/LedPower1`, '0');
            }, millisecond('0.1 seconds'));

          }
        } else {
          let matches;
          let sender;

          if(matches = topic.match(/^tasmota\/([^/]+)\/tele\/LWT$/)) {
            sender = matches[1];

            if(sender === 'steckdose') {
              return;
            }
          } else if(topic === 'vito/tele/LWT') {
            sender = 'vito';
          } else {
            throw new Error('Sender not detected');
          }

          if(messageRaw === 'Offline') {
            if(timeout[sender]) {
              // logger.warn(`${sender} timer already running: ${messageRaw}`);
            } else {
              logger.info(`${sender} timer start: ${messageRaw}`);
              timeout[sender] = setTimeout(async() => {
                logger.info(`${sender} timer trigger notification: ${messageRaw}`);

                try {
                  const transport = nodemailer.createTransport({
                    host:   'postfix',
                    port:   25,
                    secure: false,
                    tls:    {rejectUnauthorized: false},
                  });

                  await transport.sendMail({
                    to:      'stefan@heine7.de',
                    subject: `Watchdog MQTT device down ${sender} (${hostname})`,
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
              logger.info(`${sender} clear timer: ${messageRaw}`);
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
                  subject: `Watchdog MQTT device back up ${sender} (${hostname})`,
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

    await mqttClient.subscribe('tasmota/+/tele/LWT');
    await mqttClient.subscribe('tasmota/espstrom/tele/SENSOR');
    await mqttClient.subscribe('vito/tele/LWT');
    await mqttClient.subscribe('Zigbee/#');
  }
})();
