#!/usr/bin/env node

import {sendMail}  from './mail.js';

(async() => {
  await sendMail({
    to:      'technik@heine7.de',
    subject: `Test email via node`,
    html:    `
      <p>Test email via node</p>
    `,
  });
})();
