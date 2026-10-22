import { config } from '../config.js';

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

class ConsoleMailer implements Mailer {
  public sent: Mail[] = [];

  async send(mail: Mail): Promise<void> {
    this.sent.push(mail);
    if (config.NODE_ENV !== 'test') console.log(`[mail] to=${mail.to} subject=${mail.subject}\n${mail.text}`);
  }
}

class ResendMailer implements Mailer {
  async send(mail: Mail): Promise<void> {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: config.MAIL_FROM, to: mail.to, subject: mail.subject, text: mail.text }),
    });
    if (!res.ok) throw new Error(`resend failed: ${res.status} ${await res.text()}`);
  }
}

let mailer: Mailer | null = null;

export function getMailer(): Mailer {
  if (!mailer) mailer = config.MAILER === 'resend' ? new ResendMailer() : new ConsoleMailer();
  return mailer;
}

export function setMailerForTesting(m: Mailer | null): void {
  mailer = m;
}
