'use client';

import { FormEvent, useEffect, useState } from 'react';

type Stats = { scheduled: number; processing: number; sent: number; failed: number; cancelled: number };

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:5000';

export default function HomePage() {
  const [stats, setStats] = useState<Stats>({ scheduled: 0, processing: 0, sent: 0, failed: 0, cancelled: 0 });
  const [senderId, setSenderId] = useState('');
  const [recipients, setRecipients] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [scheduledAt, setScheduledAt] = useState('');
  const [delay, setDelay] = useState('5000');
  const [notice, setNotice] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function loadStats() {
    try {
      const response = await fetch(`${API_URL}/api/dashboard/stats`, { cache: 'no-store' });
      if (response.ok) setStats(await response.json());
    } catch {
      setNotice('API is not reachable. Start the backend service first.');
    }
  }

  useEffect(() => { void loadStats(); }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setNotice('');

    const recipientList = recipients.split(/[\n,]+/).map((value) => value.trim()).filter(Boolean);
    const response = await fetch(`${API_URL}/api/batches`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        senderId,
        recipients: recipientList,
        subject,
        body,
        scheduledAt,
        delayBetweenEmailsMs: Number(delay),
      }),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      setNotice(payload.error ? JSON.stringify(payload.error) : 'Unable to schedule batch.');
    } else {
      setNotice(`Batch ${payload.batchId} scheduled for ${payload.totalEmails} recipients.`);
      setRecipients('');
      setSubject('');
      setBody('');
      void loadStats();
    }
    setSubmitting(false);
  }

  return (
    <main className="container">
      <div className="header">
        <div>
          <h1 className="title">ReachInbox Scheduler</h1>
          <p className="subtitle">Reliable delayed and bulk email delivery.</p>
        </div>
      </div>

      <section className="grid">
        {Object.entries(stats).map(([key, value]) => (
          <div className="card" key={key}>
            <div className="label">{key.toUpperCase()}</div>
            <div className="stat">{value}</div>
          </div>
        ))}
      </section>

      <section className="card section">
        <h2>Schedule a batch</h2>
        <form onSubmit={submit} className="form-grid">
          <label className="field">
            <span>Sender ID</span>
            <input value={senderId} onChange={(e) => setSenderId(e.target.value)} placeholder="sender record id" required />
          </label>
          <label className="field">
            <span>Scheduled at</span>
            <input type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} required />
          </label>
          <label className="field full">
            <span>Recipients</span>
            <textarea value={recipients} onChange={(e) => setRecipients(e.target.value)} placeholder="alice@example.com\nbob@example.com" required />
          </label>
          <label className="field">
            <span>Subject</span>
            <input value={subject} onChange={(e) => setSubject(e.target.value)} required />
          </label>
          <label className="field">
            <span>Delay between emails (ms)</span>
            <input type="number" min="0" value={delay} onChange={(e) => setDelay(e.target.value)} required />
          </label>
          <label className="field full">
            <span>Body</span>
            <textarea value={body} onChange={(e) => setBody(e.target.value)} required />
          </label>
          <div className="field full">
            <button className="button" disabled={submitting}>{submitting ? 'Scheduling…' : 'Schedule batch'}</button>
            {notice && <div className="notice">{notice}</div>}
          </div>
        </form>
      </section>
    </main>
  );
}
