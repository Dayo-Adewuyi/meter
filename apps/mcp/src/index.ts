#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { MeterApi } from './meter-api.ts';
import { createMeterMcpServer } from './server.ts';

const baseUrl = process.env.METER_API_URL ?? 'http://localhost:3001';
const credential = process.env.METER_AGENT_CREDENTIAL;
if (credential === undefined || !credential.startsWith('mtr_agt_')) {
  // stdout is the protocol channel; diagnostics go to stderr.
  console.error('METER_AGENT_CREDENTIAL must be set to an mtr_agt_… token');
  process.exit(1);
}

await createMeterMcpServer(new MeterApi(baseUrl, credential)).connect(new StdioServerTransport());
