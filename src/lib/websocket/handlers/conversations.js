/**
 * @fileoverview WebSocket conversation handlers
 * Handles conversation-related WebSocket messages
 */

// Remove service role client import - use authenticated user client instead
import {
	MESSAGE_TYPES,
	serializeMessage,
	createErrorResponse,
	createSuccessResponse
} from '../utils/protocol.js';
import { roomManager } from '../utils/rooms.js';

/**
 * Get authenticated Supabase client for the user
 * @param {Object} context - Connection context with user info
 * @returns {Object} Authenticated Supabase client
 */
async function getSupabaseClient(context) {
	if (!context.supabase && context.user?.access_token) {
		// Create a client with the user's access token
		const { createClient } = await import('@supabase/supabase-js');
		
		// Use environment variables that should be available in the WebSocket plugin context
		const supabaseUrl = process.env.PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
		const supabaseKey = process.env.PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
		
		if (!supabaseUrl || !supabaseKey) {
			throw new Error('Supabase configuration missing');
		}
		
		context.supabase = createClient(supabaseUrl, supabaseKey, {
			global: {
				headers: {
					Authorization: `Bearer ${context.user.access_token}`
				}
			}
		});
	}
	return context.supabase;
}

/**
 * Handle load conversations request
 * @param {WebSocket} ws - WebSocket connection
 * @param {Object} message - Parsed message
 * @param {Object} context - Connection context
 */
export async function handleLoadConversations(ws, message, context) {
	console.log('💬 [CONVERSATIONS] ==================== LOAD CONVERSATIONS START ====================');
	console.log('💬 [CONVERSATIONS] Message received:', JSON.stringify(message, null, 2));
	console.log('💬 [CONVERSATIONS] Context check:', {
		authenticated: context.authenticated,
		hasUser: !!context.user,
		userId: context.user?.id || 'N/A',
		authUserId: context.user?.auth_user_id || 'N/A',
		username: context.user?.username || 'N/A'
	});
	
	try {
		if (!context.authenticated || !context.user) {
			console.error('💬 [CONVERSATIONS] ERROR: Authentication required');
			const errorResponse = createErrorResponse(
				message.requestId,
				'Authentication required',
				'AUTH_REQUIRED'
			);
			ws.send(serializeMessage(errorResponse));
			return;
		}

		console.log('💬 [CONVERSATIONS] Getting authenticated Supabase client...');
		const supabase = await getSupabaseClient(context);
		console.log('💬 [CONVERSATIONS] Authenticated Supabase client obtained:', !!supabase);

		// Call the database function to get user conversations
		// Use the internal user ID since the function expects the internal UUID for conversation_participants lookup
		console.log('💬 [CONVERSATIONS] Calling get_user_conversations RPC with internal user_id:', context.user.id);
		const { data: conversations, error } = await supabase
			.rpc('get_user_conversations', {
				user_uuid: context.user.id
			});

		console.log('💬 [CONVERSATIONS] RPC response:', {
			hasConversations: !!conversations,
			conversationCount: conversations?.length || 0,
			conversations: conversations?.map(c => ({
				id: c.id,
				name: c.name,
				type: c.type,
				participant_count: c.participant_count,
				last_message_at: c.last_message_at
			})) || [],
			error: error ? {
				message: error.message,
				code: error.code,
				details: error.details,
				hint: error.hint
			} : null
		});

		if (error) {
			console.error('💬 [CONVERSATIONS] ERROR: Failed to load conversations');
			console.error('💬 [CONVERSATIONS] Error details:', {
				message: error.message,
				code: error.code,
				details: error.details,
				hint: error.hint
			});
			const errorResponse = createErrorResponse(
				message.requestId,
				`Failed to load conversations: ${error.message}`,
				'DATABASE_ERROR'
			);
			ws.send(serializeMessage(errorResponse));
			return;
		}

		console.log('💬 [CONVERSATIONS] SUCCESS: Conversations loaded successfully');
		console.log('💬 [CONVERSATIONS] Conversation count:', conversations?.length || 0);

		// Decode encrypted_content from bytea to text for all conversations
		if (conversations && conversations.length > 0) {
			conversations.forEach(conv => {
				if (conv.latest_message_content) {
					try {
						// If latest_message_content is bytea, decode it to text
						if (conv.latest_message_content instanceof Uint8Array) {
							conv.latest_message_content = new TextDecoder().decode(conv.latest_message_content);
						} else if (typeof conv.latest_message_content === 'string' && conv.latest_message_content.startsWith('\\x')) {
							// Handle PostgreSQL bytea hex format
							const hexString = conv.latest_message_content.slice(2); // Remove \x prefix
							const bytes = new Uint8Array(hexString.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
							conv.latest_message_content = new TextDecoder().decode(bytes);
						}
						// If it's already a string, leave it as is
					} catch (error) {
						console.error('💬 [CONVERSATIONS] Error decoding latest message content:', error);
						conv.latest_message_content = '[Message content unavailable]';
					}
				}
			});
		}

		const response = createSuccessResponse(
			message.requestId,
			MESSAGE_TYPES.CONVERSATIONS_LOADED,
			{ conversations: conversations || [] }
		);
		
		console.log('💬 [CONVERSATIONS] Sending response with', conversations?.length || 0, 'conversations');
		ws.send(serializeMessage(response));
		
		console.log('💬 [CONVERSATIONS] ==================== LOAD CONVERSATIONS SUCCESS ====================');

	} catch (error) {
		console.error('💬 [CONVERSATIONS] ==================== LOAD CONVERSATIONS EXCEPTION ====================');
		console.error('💬 [CONVERSATIONS] Exception details:', error);
		console.error('💬 [CONVERSATIONS] Stack trace:', error.stack);
		const errorResponse = createErrorResponse(
			message.requestId,
			'Internal server error',
			'SERVER_ERROR'
		);
		ws.send(serializeMessage(errorResponse));
	}
}

/**
 * Handle join conversation request
 * @param {WebSocket} ws - WebSocket connection
 * @param {Object} message - Parsed message
 * @param {Object} context - Connection context
 */
export async function handleJoinConversation(ws, message, context) {
	console.log('💬 [JOIN] ==================== JOIN CONVERSATION START ====================');
	console.log('💬 [JOIN] Message received:', JSON.stringify(message, null, 2));
	console.log('💬 [JOIN] Context check:', {
		authenticated: context.authenticated,
		hasUser: !!context.user,
		userId: context.user?.id || 'N/A',
		username: context.user?.username || 'N/A'
	});
	
	try {
		if (!context.authenticated || !context.user) {
			console.error('💬 [JOIN] ERROR: Authentication required');
			const errorResponse = createErrorResponse(
				message.requestId,
				'Authentication required',
				'AUTH_REQUIRED'
			);
			ws.send(serializeMessage(errorResponse));
			return;
		}

		const { conversationId } = message.payload;
		console.log('💬 [JOIN] Conversation ID from payload:', conversationId);
		
		if (!conversationId) {
			console.error('💬 [JOIN] ERROR: No conversation ID provided');
			const errorResponse = createErrorResponse(
				message.requestId,
				'Conversation ID required',
				'INVALID_DATA'
			);
			ws.send(serializeMessage(errorResponse));
			return;
		}

		console.log('💬 [JOIN] Getting authenticated Supabase client...');
		const supabase = await getSupabaseClient(context);

		// Verify user has access to this conversation
		// Use the internal user ID (not auth_user_id) for conversation_participants lookup
		console.log('💬 [JOIN] Checking participant access:', {
			conversationId,
			userId: context.user.id,
			table: 'conversation_participants'
		});
		
		const { data: participant, error } = await supabase
			.from('conversation_participants')
			.select('*')
			.eq('conversation_id', conversationId)
			.eq('user_id', context.user.id)
			.single();

		console.log('💬 [JOIN] Participant query result:', {
			hasParticipant: !!participant,
			participant: participant ? {
				conversation_id: participant.conversation_id,
				user_id: participant.user_id,
				joined_at: participant.joined_at
			} : null,
			error: error ? {
				message: error.message,
				code: error.code,
				details: error.details,
				hint: error.hint
			} : null
		});

		if (error || !participant) {
			console.error('💬 [JOIN] ERROR: Access denied to conversation');
			console.error('💬 [JOIN] Access denied details:', {
				conversationId,
				userId: context.user.id,
				error: error
			});
			const errorResponse = createErrorResponse(
				message.requestId,
				'Access denied to conversation',
				'ACCESS_DENIED'
			);
			ws.send(serializeMessage(errorResponse));
			return;
		}

		// Add user to conversation room
		console.log('💬 [JOIN] Adding user to room:', {
			conversationId,
			userId: context.user.id
		});
		roomManager.joinRoom(ws, conversationId, context.user.id);

		const response = createSuccessResponse(
			message.requestId,
			MESSAGE_TYPES.CONVERSATION_JOINED,
			{ conversationId }
		);
		
		console.log('💬 [JOIN] Sending success response:', JSON.stringify(response, null, 2));
		ws.send(serializeMessage(response));
		
		console.log('💬 [JOIN] ==================== JOIN CONVERSATION SUCCESS ====================');

	} catch (error) {
		console.error('💬 [JOIN] ==================== JOIN CONVERSATION EXCEPTION ====================');
		console.error('💬 [JOIN] Exception details:', error);
		console.error('💬 [JOIN] Stack trace:', error.stack);
		const errorResponse = createErrorResponse(
			message.requestId,
			'Internal server error',
			'SERVER_ERROR'
		);
		ws.send(serializeMessage(errorResponse));
	}
}

/**
 * Handle leave conversation request
 * @param {WebSocket} ws - WebSocket connection
 * @param {Object} message - Parsed message
 * @param {Object} context - Connection context
 */
export async function handleLeaveConversation(ws, message, context) {
	try {
		if (!context.authenticated || !context.user) {
			const errorResponse = createErrorResponse(
				message.requestId,
				'Authentication required',
				'AUTH_REQUIRED'
			);
			ws.send(serializeMessage(errorResponse));
			return;
		}

		const { conversationId } = message.payload;
		if (!conversationId) {
			const errorResponse = createErrorResponse(
				message.requestId,
				'Conversation ID required',
				'INVALID_DATA'
			);
			ws.send(serializeMessage(errorResponse));
			return;
		}

		// Remove user from conversation room
		roomManager.leaveRoom(ws, conversationId);

		const response = createSuccessResponse(
			message.requestId,
			MESSAGE_TYPES.CONVERSATION_LEFT,
			{ conversationId }
		);
		ws.send(serializeMessage(response));

	} catch (error) {
		console.error('Error in handleLeaveConversation:', error);
		const errorResponse = createErrorResponse(
			message.requestId,
			'Internal server error',
			'SERVER_ERROR'
		);
		ws.send(serializeMessage(errorResponse));
	}
}

/**
 * Handle create conversation request
 * @param {WebSocket} ws - WebSocket connection
 * @param {Object} message - Parsed message
 * @param {Object} context - Connection context
 */
export async function handleCreateConversation(ws, message, context) {
	console.log('💬 [CREATE] ==================== CREATE CONVERSATION START ====================');
	console.log('💬 [CREATE] Message received:', JSON.stringify(message, null, 2));
	console.log('💬 [CREATE] Context check:', {
		authenticated: context.authenticated,
		hasUser: !!context.user,
		userId: context.user?.id || 'N/A',
		username: context.user?.username || 'N/A'
	});
	
	try {
		if (!context.authenticated || !context.user) {
			console.error('💬 [CREATE] ERROR: Authentication required');
			const errorResponse = createErrorResponse(
				message.requestId,
				'Authentication required',
				'AUTH_REQUIRED'
			);
			ws.send(serializeMessage(errorResponse));
			return;
		}

		const { participantIds, name, isGroup } = message.payload;
		console.log('💬 [CREATE] Payload data:', {
			participantIds,
			name,
			isGroup,
			participantIdsType: typeof participantIds,
			isArray: Array.isArray(participantIds)
		});
		
		if (!participantIds || !Array.isArray(participantIds)) {
			console.error('💬 [CREATE] ERROR: Invalid participant IDs');
			const errorResponse = createErrorResponse(
				message.requestId,
				'Participant IDs required',
				'INVALID_DATA'
			);
			ws.send(serializeMessage(errorResponse));
			return;
		}

		const supabase = await getSupabaseClient(context);

		// Determine conversation type and data
		const isDirectMessage = !isGroup && participantIds.length === 1;
		
		// For direct messages, check if a conversation already exists between these users
		if (isDirectMessage) {
			const otherUserId = participantIds[0];
			console.log('💬 [CREATE] Checking for existing direct conversation:', {
				currentUserId: context.user.id,
				otherUserId: otherUserId,
				isDirectMessage: true
			});
			
			// Query for existing direct conversation between these two users
			const { data: existingConversations, error: searchError } = await supabase
				.from('conversations')
				.select(`
					*,
					conversation_participants!inner(user_id)
				`)
				.eq('type', 'direct')
				.eq('conversation_participants.user_id', context.user.id);
			
			if (searchError) {
				console.error('💬 [CREATE] Error searching for existing conversations:', searchError);
			} else if (existingConversations && existingConversations.length > 0) {
				// Check if any of these conversations also include the other user
				for (const conv of existingConversations) {
					const { data: otherParticipant, error: participantError } = await supabase
						.from('conversation_participants')
						.select('user_id')
						.eq('conversation_id', conv.id)
						.eq('user_id', otherUserId)
						.single();
					
					if (!participantError && otherParticipant) {
						console.log('💬 [CREATE] Found existing direct conversation:', {
							conversationId: conv.id,
							participants: [context.user.id, otherUserId]
						});
						
						// Return the existing conversation instead of creating a new one
						const response = createSuccessResponse(
							message.requestId,
							MESSAGE_TYPES.CONVERSATION_CREATED,
							{ conversation: conv }
						);
						
						console.log('💬 [CREATE] Returning existing conversation:', JSON.stringify(response, null, 2));
						ws.send(serializeMessage(response));
						return;
					}
				}
			}
			
			console.log('💬 [CREATE] No existing direct conversation found, creating new one');
		}

		const conversationData = {
			type: isDirectMessage ? 'direct' : 'room',
			name: isDirectMessage ? null : (name || null), // Direct messages don't have names
			is_private: !isGroup, // Direct messages are private by default
			created_by: context.user.id
		};

		console.log('💬 [CREATE] Creating conversation with data:', conversationData);
		const { data: conversation, error: conversationError } = await supabase
			.from('conversations')
			.insert(conversationData)
			.select()
			.single();

		if (conversationError) {
			console.error('💬 [CREATE] ERROR: Failed to create conversation');
			console.error('💬 [CREATE] Conversation error:', conversationError);
			const errorResponse = createErrorResponse(
				message.requestId,
				'Failed to create conversation',
				'DATABASE_ERROR'
			);
			ws.send(serializeMessage(errorResponse));
			return;
		}

		console.log('💬 [CREATE] Conversation created successfully:', {
			id: conversation.id,
			type: conversation.type,
			created_by: conversation.created_by
		});

		// Add additional participants (creator is automatically added by database trigger)
		if (participantIds && participantIds.length > 0) {
			// Filter out the creator since they're already added by the trigger
			const additionalParticipantIds = participantIds.filter(id => id !== context.user.id);
			
			if (additionalParticipantIds.length > 0) {
				console.log('💬 [CREATE] Adding additional participants:', {
					creatorId: context.user.id,
					originalParticipantIds: participantIds,
					additionalParticipantIds: additionalParticipantIds,
					additionalParticipantCount: additionalParticipantIds.length
				});
				
				const participantData = additionalParticipantIds.map(userId => ({
					conversation_id: conversation.id,
					user_id: userId,
					role: 'member',
					joined_at: new Date().toISOString()
				}));

				console.log('💬 [CREATE] Inserting additional participant data:', participantData);
				const { error: participantError } = await supabase
					.from('conversation_participants')
					.insert(participantData);

				if (participantError) {
					console.error('💬 [CREATE] ERROR: Failed to add additional participants');
					console.error('💬 [CREATE] Participant error:', participantError);
					// Try to clean up the conversation
					await supabase.from('conversations').delete().eq('id', conversation.id);
					
					const errorResponse = createErrorResponse(
						message.requestId,
						'Failed to add participants',
						'DATABASE_ERROR'
					);
					ws.send(serializeMessage(errorResponse));
					return;
				}

				console.log('💬 [CREATE] Additional participants added successfully');
			} else {
				console.log('💬 [CREATE] No additional participants to add (creator already added by trigger)');
			}
		} else {
			console.log('💬 [CREATE] No additional participants specified');
		}

		// Join the creator to the conversation room
		console.log('💬 [CREATE] Adding creator to room:', {
			conversationId: conversation.id,
			creatorId: context.user.id
		});
		roomManager.joinRoom(ws, conversation.id, context.user.id);

		const response = createSuccessResponse(
			message.requestId,
			MESSAGE_TYPES.CONVERSATION_CREATED,
			{ conversation }
		);
		
		console.log('💬 [CREATE] Sending success response:', JSON.stringify(response, null, 2));
		ws.send(serializeMessage(response));
		
		console.log('💬 [CREATE] ==================== CREATE CONVERSATION SUCCESS ====================');

	} catch (error) {
		console.error('💬 [CREATE] ==================== CREATE CONVERSATION EXCEPTION ====================');
		console.error('💬 [CREATE] Exception details:', error);
		console.error('💬 [CREATE] Stack trace:', error.stack);
		const errorResponse = createErrorResponse(
			message.requestId,
			'Internal server error',
			'SERVER_ERROR'
		);
		ws.send(serializeMessage(errorResponse));
	}
}
