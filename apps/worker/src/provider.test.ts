import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createProvider, GmailProvider, OutlookProvider, SmtpProvider } from './provider.js';

test('selects SMTP provider', () => assert.ok(createProvider('SMTP') instanceof SmtpProvider));
test('selects Gmail provider', () => assert.ok(createProvider('GMAIL') instanceof GmailProvider));
test('selects Outlook provider', () => assert.ok(createProvider('OUTLOOK') instanceof OutlookProvider));
test('defaults unknown providers to SMTP', () => assert.ok(createProvider('UNKNOWN') instanceof SmtpProvider));
