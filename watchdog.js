#!/usr/bin/env node

/* eslint-disable no-cond-assign */
/* eslint-disable prefer-named-capture-group */

import {setTimeout as delay} from 'timers/promises';
import os                    from 'os';

import axios                 from 'axios';
import express               from 'express';
import mqtt                  from 'async-mqtt';
import ms                    from 'ms';

import logger                from './logger.js';
import {sendMail}            from './mail.js';

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
let   stromTriggerCounter = 0;
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
    let retry = 3;

    do {
      try {
        const response = await axios.get(`http://${server}.fritz.box:31038/health`, {
          timeout: ms('5 seconds'),
        });

//        logger.info(`Got ${server}`, response.data);

        retry = 0;

        if(response.data === 'ok') {
          error = null;
        } else {
          error = response.data;

          logger.error(`Server unhealthy ${server}: ${error}`);
        }
      } catch(err) {
        error = `Server unresponsive ${server} (retry=${retry}): ${err.message}`;

        if(retry) {
          retry--;
        }

        if(retry) {
          await delay(ms('5 seconds'));
          logger.error(error);
        }
      }
    } while(retry);

    if(error) {
      if(timeout[server]) {
        // logger.warn(`${server} timer already running`);
      } else {
        logger.info(`${server} timer start: ${error}`);
        timeout[server] = setTimeout(async() => {
          logger.info(`${server} timer trigger notification: ${error}`);

          try {
            await sendMail({
              to:      'technik@heine7.de',
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
        }, ms('20 minutes'));
      }
    } else {
      if(timeout[server]) {
        logger.info(`${server} clear timer`);
        clearTimeout(timeout[server]);
        Reflect.deleteProperty(timeout, server);
      }

      if(notified[server]) {
        try {
          await sendMail({
            to:      'technik@heine7.de',
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

  setInterval(checkServers, ms('1 minutes'));

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

        switch(true) {
          case topic.startsWith('Zigbee/'): {
            if(topic === 'Zigbee/bridge/event' && message.type === 'device_joined') {
              await sendMail({
                to:      'technik@heine7.de',
                subject: `MQTT device joined '${message.data.friendly_name}'`,
                html:    `
                  <p>MQTT device joined</p>
                  ${message.data.friendly_name}
                  <br />
                  ${message.data.ieee_address}
                `,
              });

              return;
            }
            if(topic.startsWith('Zigbee/bridge')) {
              return;
            }
            if(topic.endsWith('/availability')) {
              return;
            }

            const sender = topic.replace(/^Zigbee\//, '');
            const {battery} = message;

            // LuftSensor Büro battery=14, then dead
            if(battery < 16) {
              logger.warn(`${sender} battery=${battery}`);
            }

            // logger.info(topic, messageRaw);

            if(timeout[sender]) {
              clearTimeout(timeout[sender]);
            }

            timeout[sender] = setTimeout(async() => {
              logger.info(`${sender} timer trigger notification`);

              try {
                await sendMail({
                  to:      'technik@heine7.de',
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
            }, ms('15 hours'));

            if(notified[sender]) {
              try {
                await sendMail({
                  to:      'technik@heine7.de',
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
            break;
          }

          case topic === 'tasmota/espstrom/tele/SENSOR': {
            const sender       = 'espstrom';
            const currentStrom = `${message.SML.Verbrauch}:${message.SML.Einspeisung}:${message.SML.Leistung}`;

            if(lastStrom === currentStrom) {
              stromTriggerCounter++;

              if(stromTriggerCounter > 12) { // 12 * 10s = 2 minutes, no update, trigger warning
                if(timeout[sender]) {
                  logger.warn(`${sender} timer already running`, message);
                } else {
                  logger.info(`${sender} timer start`, message);
                  timeout[sender] = setTimeout(async() => {
                    logger.info(`${sender} timer trigger notification`, message);

                    try {
                      await sendMail({
                        to:      'technik@heine7.de',
                        subject: `Watchdog MQTT device down ${sender} (${hostname})`,
                        html:    `
                          <p>Watchdog on ${hostname} detected MQTT device down, or Smart Meter not configured:</p>
                          <p><pre>${sender} ${messageRaw}</pre></p>
                        `,
                      });

                      notified[sender] = true;
                    } catch(err) {
                      logger.error(`Failed to send error mail: ${err.message}`);
                    }
                  }, ms('5 minutes'));
                }
              }
            } else {
              stromTriggerCounter = 0;

              if(timeout[sender]) {
                logger.info(`${sender} clear timer`, message);
                clearTimeout(timeout[sender]);
                Reflect.deleteProperty(timeout, sender);
              }

              if(notified[sender]) {
                try {
                  await sendMail({
                    to:      'technik@heine7.de',
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
            }
            break;
          }

          case topic.endsWith('/tele/LWT'): {
            let matches;
            let sender;

            if(matches = topic.match(/^tasmota\/([^/]+)\/tele\/LWT$/)) {
              sender = matches[1];

              if(['steckdose', 'druckerkamera'].includes(sender)) {
                // Ignore alive-stats for these devices
                return;
              }
            } else if(topic === 'vito/tele/LWT') {
              sender = 'vito';
            } else {
              throw new Error('Sender not detected');
            }

            switch(messageRaw) {
              case 'Offline':
                if(timeout[sender]) {
                  // logger.warn(`${sender} timer already running: ${messageRaw}`);
                } else {
                  timeout[`${sender}-log`] = setTimeout(async() => {
                    // Delay the logging, as there is often an Offline/Online within a few seconds.
                    logger.info(`${sender} timer start: ${messageRaw}`);
                  }, ms('2 seconds'));
                  timeout[sender] = setTimeout(async() => {
                    logger.info(`${sender} timer trigger notification: ${messageRaw}`);

                    try {
                      await sendMail({
                        to:      'technik@heine7.de',
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
                  }, ms('20 minutes'));
                }
                break;

              case 'Online':
                if(timeout[sender]) {
                  if(timeout[`${sender}-log`]) {
                    clearTimeout(timeout[`${sender}-log`]);
                    Reflect.deleteProperty(timeout, `${sender}-log`);
                  } else {
                    logger.info(`${sender} clear timer: ${messageRaw}`);
                  }
                  clearTimeout(timeout[sender]);
                  Reflect.deleteProperty(timeout, sender);
                }

                if(notified[sender]) {
                  try {
                    await sendMail({
                      to:      'technik@heine7.de',
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
                break;

              default:
                logger.warn(`Unhandled LWT status '${messageRaw}' in '${topic}'`);
                break;
            }
            break;
          }

          default:
            logger.warn(`Unhandled topic '${topic}'`);
            break;
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
