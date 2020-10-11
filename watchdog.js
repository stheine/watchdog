#!/usr/bin/env node

'use strict';

const os          = require('os');

const dayjs       = require('dayjs');
const express     = require('express');
const millisecond = require('millisecond');
const needle      = require('needle');
const nodemailer  = require('nodemailer');

const hostname = os.hostname();
const servers  = [
  'pi-jalousie',
  'qnap',
  'pi-strom',
  'pi-wecker',
];

// ###########################################################################
// Logging

/* eslint-disable no-console */
const logger = {
  info(msg, params) {
    if(params) {
      console.log(`${dayjs().format('YYYY-MM-DD HH:mm:ss')} INFO`, msg, params);
    } else {
      console.log(`${dayjs().format('YYYY-MM-DD HH:mm:ss')} INFO`, msg);
    }
  },
  warn(msg, params) {
    if(params) {
      console.log(`${dayjs().format('YYYY-MM-DD HH:mm:ss')} WARN`, msg, params);
    } else {
      console.log(`${dayjs().format('YYYY-MM-DD HH:mm:ss')} WARN`, msg);
    }
  },
  error(msg, params) {
    if(params) {
      console.log(`${dayjs().format('YYYY-MM-DD HH:mm:ss')} ERROR`, msg, params);
    } else {
      console.log(`${dayjs().format('YYYY-MM-DD HH:mm:ss')} ERROR`, msg);
    }
  },
};
/* eslint-enable no-console */

// ###########################################################################
// Process handling

const stopProcess = async function() {
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
      // console.log(`Skipping ${server}`);

      continue;
    }

    console.log(`Checking ${server}`);

    try {
      const result = await needle(`http://${server}.fritz.box:31038/health`);

      console.log(`Got ${server}`, result);
    } catch(err) {
      console.error(`Server down ${server}: ${err.message}`);

      errors.push(`Server down ${server}: ${err.message}`);
    }
  }

  if(errors.length) {
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
  }
};

// ###########################################################################
// Main

(async() => {
  // #########################################################################
  // Startup

  logger.info(`Startup --------------------------------------------------`);

  // #########################################################################
  // Start server

  const app = express();

  app.get('/health', (res, req) => {
    req.send('ok');
  });

  app.listen(31038);

  logger.info(`Listening ------------------------------------------------`);

  // #########################################################################
  // Start monitor loop

  await checkServers();

  setInterval(checkServers, millisecond('15 minutes'));
})();
