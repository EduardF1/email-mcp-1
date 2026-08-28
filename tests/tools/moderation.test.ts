import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AccountManager } from '../../src/account-manager.js';
import { registerModerationTools } from '../../src/tools/moderation.js';
import type { EmailProvider } from '../../src/providers/provider.js';
import type { BlockRule } from '../../src/models/types.js';

// --- helpers ---

function makeMockProvider(overrides: Partial<EmailProvider> = {}): EmailProvider {
  return {
    providerType: 'gmail',
    connect: vi.fn(),
    disconnect: vi.fn(),
    testConnection: vi.fn(),
    listFolders: vi.fn(),
    createFolder: vi.fn(),
    search: vi.fn(),
    getEmail: vi.fn(),
    getThread: vi.fn(),
    getAttachment: vi.fn(),
    sendEmail: vi.fn(),
    createDraft: vi.fn(),
    listDrafts: vi.fn(),
    moveEmail: vi.fn(),
    deleteEmail: vi.fn(),
    markEmail: vi.fn(),
    reportSpam: vi.fn().mockResolvedValue(undefined),
    createBlockRule: vi.fn().mockResolvedValue({ id: 'rule-1' }),
    listBlockRules: vi.fn().mockResolvedValue([] as BlockRule[]),
    deleteBlockRule: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as EmailProvider;
}

// Provider shaped like the IMAP adapter: reportSpam only, no block-rule support.
function makeImapLikeProvider(): EmailProvider {
  const provider = makeMockProvider({ providerType: 'imap' }) as any;
  delete provider.createBlockRule;
  delete provider.listBlockRules;
  delete provider.deleteBlockRule;
  return provider as EmailProvider;
}

function getRegisteredTools(server: McpServer): Record<string, { handler: Function }> {
  return (server as any)._registeredTools;
}

function hasRegisteredTool(server: McpServer, toolName: string): boolean {
  return toolName in getRegisteredTools(server);
}

async function callTool(
  server: McpServer,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const tools = getRegisteredTools(server);
  const tool = tools[toolName];
  if (!tool) throw new Error(`Tool ${toolName} not registered`);
  const result = await (tool.handler as Function)(args, {});
  return result as { content: Array<{ type: string; text: string }> };
}

// --- tests ---

describe('Moderation tools', () => {
  let server: McpServer;
  let accountManager: AccountManager;
  let mockProvider: EmailProvider;

  beforeEach(() => {
    server = new McpServer({ name: 'test', version: '0.0.1' });
    mockProvider = makeMockProvider();
    accountManager = {
      getProvider: vi.fn().mockResolvedValue(mockProvider),
    } as unknown as AccountManager;
    registerModerationTools(server, accountManager);
  });

  describe('email_report_spam', () => {
    it('is registered', () => {
      expect(hasRegisteredTool(server, 'email_report_spam')).toBe(true);
    });

    it('calls provider.reportSpam with correct params', async () => {
      const result = await callTool(server, 'email_report_spam', {
        accountId: 'acct-1',
        emailId: 'msg-1',
      });

      expect(accountManager.getProvider).toHaveBeenCalledWith('acct-1');
      expect(mockProvider.reportSpam).toHaveBeenCalledWith('msg-1', undefined);

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
    });

    it('returns error when provider throws', async () => {
      (mockProvider.reportSpam as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));

      const result = await callTool(server, 'email_report_spam', { accountId: 'acct-1', emailId: 'msg-1' });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('boom');
    });
  });

  describe('email_batch_report_spam', () => {
    it('reports each email, collecting successes and failures', async () => {
      (mockProvider.reportSpam as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('not found'));

      const result = await callTool(server, 'email_batch_report_spam', {
        accountId: 'acct-1',
        emailIds: ['msg-1', 'msg-2'],
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.succeeded).toEqual(['msg-1']);
      expect(parsed.failed).toEqual([{ id: 'msg-2', error: 'not found' }]);
    });
  });

  describe('email_create_block_rule', () => {
    it('calls provider.createBlockRule with correct params', async () => {
      const result = await callTool(server, 'email_create_block_rule', {
        accountId: 'acct-1',
        matchType: 'headerContains',
        value: 'in2.getdrip.com',
        action: 'moveToJunk',
      });

      expect(mockProvider.createBlockRule).toHaveBeenCalledWith({
        matchType: 'headerContains',
        value: 'in2.getdrip.com',
        action: 'moveToJunk',
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.data).toEqual({ id: 'rule-1' });
    });

    it('returns a clear "not supported" error for providers without block rules (IMAP)', async () => {
      accountManager = {
        getProvider: vi.fn().mockResolvedValue(makeImapLikeProvider()),
      } as unknown as AccountManager;
      server = new McpServer({ name: 'test', version: '0.0.1' });
      registerModerationTools(server, accountManager);

      const result = await callTool(server, 'email_create_block_rule', {
        accountId: 'acct-1',
        matchType: 'senderDomain',
        value: 'bad.com',
        action: 'delete',
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('not supported');
      expect(parsed.supportedProviders).toEqual(['gmail', 'outlook']);
    });
  });

  describe('email_list_block_rules', () => {
    it('calls provider.listBlockRules', async () => {
      const rules: BlockRule[] = [
        { id: 'r1', matchType: 'senderDomain', value: 'bad.com', action: 'delete', createdAt: '' },
      ];
      (mockProvider.listBlockRules as ReturnType<typeof vi.fn>).mockResolvedValue(rules);

      const result = await callTool(server, 'email_list_block_rules', { accountId: 'acct-1' });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.data).toEqual(rules);
    });
  });

  describe('email_delete_block_rule', () => {
    it('calls provider.deleteBlockRule with the rule id', async () => {
      const result = await callTool(server, 'email_delete_block_rule', {
        accountId: 'acct-1',
        ruleId: 'rule-1',
      });

      expect(mockProvider.deleteBlockRule).toHaveBeenCalledWith('rule-1');

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
    });
  });
});
