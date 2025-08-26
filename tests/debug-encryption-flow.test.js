/**
 * Debug test to verify the complete encryption flow
 */

import { describe, it, beforeEach, expect } from 'vitest';
import { clientEncryption } from '../src/lib/crypto/client-encryption.js';

describe('Debug Encryption Flow', () => {
	beforeEach(async () => {
		// Clear any existing keys
		await clientEncryption.clearAllKeys();
		// Initialize the service
		await clientEncryption.initialize();
	});

	it('should encrypt and decrypt a simple message', async () => {
		const conversationId = 'test-conversation-123';
		const originalMessage = 'Hello, this is a test message!';

		console.log('🔐 Testing encryption flow...');
		console.log('Original message:', originalMessage);

		// Encrypt the message
		const encryptedContent = await clientEncryption.encryptMessage(conversationId, originalMessage);
		console.log('Encrypted content:', encryptedContent);
		
		expect(encryptedContent).to.be.a('string');
		expect(encryptedContent).to.not.equal(originalMessage);
		
		// Verify it's valid JSON
		const encryptedData = JSON.parse(encryptedContent);
		expect(encryptedData).to.have.property('v', 1);
		expect(encryptedData).to.have.property('n');
		expect(encryptedData).to.have.property('c');

		// Decrypt the message
		const decryptedContent = await clientEncryption.decryptMessage(conversationId, encryptedContent);
		console.log('Decrypted content:', decryptedContent);
		
		expect(decryptedContent).to.equal(originalMessage);
	});

	it('should handle multiple messages in the same conversation', async () => {
		const conversationId = 'test-conversation-456';
		const messages = [
			'First message',
			'Second message with emojis 🔐✨',
			'Third message with special chars: !@#$%^&*()'
		];

		console.log('🔐 Testing multiple messages...');

		for (let i = 0; i < messages.length; i++) {
			const original = messages[i];
			console.log(`Message ${i + 1}:`, original);

			const encrypted = await clientEncryption.encryptMessage(conversationId, original);
			const decrypted = await clientEncryption.decryptMessage(conversationId, encrypted);
			
			expect(decrypted).to.equal(original);
			console.log(`✅ Message ${i + 1} encrypted/decrypted successfully`);
		}
	});

	it('should handle plain text fallback', async () => {
		const conversationId = 'test-conversation-789';
		const plainText = 'This is plain text, not encrypted';

		console.log('🔐 Testing plain text fallback...');
		console.log('Plain text:', plainText);

		// Try to decrypt plain text (should return as-is)
		const result = await clientEncryption.decryptMessage(conversationId, plainText);
		console.log('Result:', result);
		
		expect(result).to.equal(plainText);
	});

	it('should handle invalid encrypted content gracefully', async () => {
		const conversationId = 'test-conversation-invalid';
		const invalidContent = '{"invalid": "json", "missing": "required_fields"}';

		console.log('🔐 Testing invalid encrypted content...');
		console.log('Invalid content:', invalidContent);

		// Try to decrypt invalid content (should return as-is)
		const result = await clientEncryption.decryptMessage(conversationId, invalidContent);
		console.log('Result:', result);
		
		expect(result).to.equal(invalidContent);
	});

	it('should generate and reuse conversation keys', async () => {
		const conversationId = 'test-conversation-key-reuse';
		
		console.log('🔐 Testing key generation and reuse...');

		// Get key first time (should generate)
		const key1 = await clientEncryption.getConversationKey(conversationId);
		console.log('First key generated, length:', key1.length);
		expect(key1).to.be.instanceOf(Uint8Array);
		expect(key1.length).to.equal(32);

		// Get key second time (should reuse)
		const key2 = await clientEncryption.getConversationKey(conversationId);
		console.log('Second key retrieved, length:', key2.length);
		expect(key2).to.deep.equal(key1);

		// Verify encryption works with reused key
		const message = 'Test message with reused key';
		const encrypted = await clientEncryption.encryptMessage(conversationId, message);
		const decrypted = await clientEncryption.decryptMessage(conversationId, encrypted);
		
		expect(decrypted).to.equal(message);
		console.log('✅ Key reuse works correctly');
	});
});