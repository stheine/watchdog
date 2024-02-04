import os         from 'node:os';

import nodemailer from 'nodemailer';

const hostname = os.hostname();

export const sendMail = async function({to, subject, html}) {
  const transport = nodemailer.createTransport({
    host:   'wyse.fritz.box',
    port:   25,
    secure: false,
    tls:    {rejectUnauthorized: false},
  });

  await transport.sendMail({from: `"${hostname}" technik@heine7.de`, to, subject, html});
};
