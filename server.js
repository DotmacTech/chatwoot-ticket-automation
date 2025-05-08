/**
 * server.js - Main application file
 *
 * Professional Chatwoot Ticket Automation Backend
 * Handles webhook ingestion, ticket assignment, and database cleanup for Chatwoot.
 *
 * Author: DotmacTech
 * License: MIT
 */

require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

// ========== LOGGING SETUP ==========
// Create logs directory if it doesn't exist
const logDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir);
}
const logFile = path.join(logDir, 'chatwoot-automation.log');
const logStream = fs.createWriteStream(logFile, { flags: 'a' });

/**
 * Logs a message to both the console and the log file, with timestamp and level.
 * @param {string} message - The message to log.
 * @param {string} [level='INFO'] - Log level (INFO, ERROR, WARNING, etc).
 */
function logger(message, level = 'INFO') {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] [${level}] ${message}`;
  // Log to console
  console.log(logMessage);
  // Log to file
  logStream.write(logMessage + '\n');
}

// ========== ENVIRONMENT CONFIGURATION ==========
const app = express();
const PORT = process.env.PORT || 3050;
const CHATWOOT_API_KEY = process.env.CHATWOOT_API_KEY; // Chatwoot API key (required)
const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID; // Chatwoot account ID (required)
const CHATWOOT_TEAM_ID = process.env.CHATWOOT_TEAM_ID; // Team ID to assign tickets to (required)
const CHATWOOT_BASE_URL = process.env.CHATWOOT_BASE_URL || 'https://chat.dotmac.ng/api/v1'; // API base URL
const DB_CLEANUP_DAYS = process.env.DB_CLEANUP_DAYS || 7; // Days to keep processed records before deletion

// ========== DATABASE INITIALIZATION ==========
/**
 * SQLite database for storing conversation records.
 * Table: conversations
 * Columns:
 *   - id: INTEGER PRIMARY KEY
 *   - status: TEXT
 *   - created_at: INTEGER (UNIX timestamp)
 *   - inbox_id: INTEGER
 *   - processed: BOOLEAN (0 = not processed, 1 = processed)
 *   - processed_at: INTEGER (UNIX timestamp, when processed)
 */
const db = new sqlite3.Database('./conversations.db', (err) => {
  if (err) {
    logger(`Error opening database: ${err.message}`, 'ERROR');
  } else {
    logger('Connected to the SQLite database.');
    // Create table if it doesn't exist
    db.run(`CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY,
      status TEXT,
      created_at INTEGER,
      inbox_id INTEGER,
      processed BOOLEAN DEFAULT 0,
      processed_at INTEGER DEFAULT NULL
    )`, (err) => {
      if (err) {
        logger(`Error creating table: ${err.message}`, 'ERROR');
      } else {
        logger('Table created or already exists.');
        // Log the current conversations in the database
        db.all('SELECT * FROM conversations', [], (err, rows) => {
          if (err) {
            logger(`Error querying conversations: ${err.message}`, 'ERROR');
          } else {
            logger(`Current conversations in database: ${rows.length}`);
            if (rows.length > 0) {
              logger(`First 5 conversations: ${JSON.stringify(rows.slice(0, 5))}`);
            }
          }
        });
      }
    });
  }
});

// ========== MIDDLEWARE ==========
// Parse JSON bodies for incoming requests
app.use(bodyParser.json());

/**
 * Webhook endpoint to receive Chatwoot payloads.
 *
 * This endpoint is triggered by Chatwoot webhooks when a new conversation is created.
 * It extracts the conversation data and stores it in the local SQLite database for processing.
 *
 * Expected payload: {
 *   event: 'conversation_created',
 *   id: <conversation_id>,
 *   status: <status>,
 *   created_at: <timestamp>,
 *   inbox_id: <inbox_id>,
 *   ...
 * }
 */
app.post('/webhook/chatwoot', (req, res) => {
  logger('Webhook received. Processing payload...');
  try {
    const payload = req.body;
    logger(`Webhook payload: ${JSON.stringify(payload)}`);
    // Only process conversation_created events
    if (payload.event === 'conversation_created') {
      logger('Conversation created event detected');
      // Extract conversation details from payload
      const conversation = {
        id: payload.id,
        status: payload.status,
        created_at: payload.created_at || payload.timestamp,
        inbox_id: payload.inbox_id
      };
      logger(`Extracted conversation data: ${JSON.stringify(conversation)}`);
      // Store conversation in the database (idempotent)
      const stmt = db.prepare('INSERT OR REPLACE INTO conversations (id, status, created_at, inbox_id, processed) VALUES (?, ?, ?, ?, 0)');
      stmt.run(
        conversation.id,
        conversation.status,
        conversation.created_at,
        conversation.inbox_id,
        function(err) {
          if (err) {
            logger(`Error inserting conversation ${conversation.id}: ${err.message}`, 'ERROR');
          } else {
            logger(`New conversation stored successfully: ID=${conversation.id}, Status=${conversation.status}`);
          }
        }
      );
      stmt.finalize();
    } else {
      logger(`Ignoring non-conversation_created event: ${payload.event}`);
    }
    res.status(200).send('Webhook received');
  } catch (error) {
    logger(`Error processing webhook: ${error.message}`, 'ERROR');
    logger(`Request body: ${JSON.stringify(req.body, null, 2)}`, 'ERROR');
    res.status(500).send('Error processing webhook');
  }
});

/**
 * Health check endpoint.
 *
 * Returns 200 OK if the server is running.
 * Useful for monitoring and uptime checks.
 */
app.get('/health', (req, res) => {
  logger('Health check endpoint accessed');
  res.status(200).send('Server is running');
});

/**
 * Debug endpoint to test database connection and view all conversations.
 *
 * Returns all rows from the conversations table as JSON.
 * Use for diagnostics and debugging only.
 */
app.get('/debug/db', (req, res) => {
  logger('Database debug endpoint accessed');
  db.all('SELECT * FROM conversations', [], (err, rows) => {
    if (err) {
      logger(`Error querying conversations: ${err.message}`, 'ERROR');
      res.status(500).json({ error: err.message });
    } else {
      logger(`Returning ${rows.length} conversations`);
      res.status(200).json({ conversations: rows });
    }
  });
});

/**
 * Checks the current status of a conversation via the Chatwoot API.
 *
 * @param {number} conversationId - The Chatwoot conversation ID.
 * @returns {Promise<string|null>} - The current status (e.g., 'pending', 'open', etc) or null on error.
 */
async function checkConversationStatus(conversationId) {
  logger(`Checking status for conversation ${conversationId}...`);
  try {
    const url = `${CHATWOOT_BASE_URL}/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}`;
    logger(`Making API request to: ${url}`);
    // Use API key as header for authentication
    const response = await axios.get(url, {
      headers: {
        'Content-Type': 'application/json',
        'api_access_token': CHATWOOT_API_KEY
      }
    });
    logger(`Conversation ${conversationId} status: ${response.data.status}`);
    return response.data.status;
  } catch (error) {
    logger(`Error checking conversation ${conversationId} status: ${error.message}`, 'ERROR');
    if (error.response) {
      logger(`API response: ${error.response.status} - ${JSON.stringify(error.response.data)}`, 'ERROR');
    }
    return null;
  }
}

/**
 * Sets a conversation's status to 'open' via the Chatwoot API.
 *
 * @param {number} conversationId - The Chatwoot conversation ID.
 * @returns {Promise<boolean>} - True if successful, false otherwise.
 */
async function openConversation(conversationId) {
  logger(`Opening conversation ${conversationId}...`);
  try {
    const url = `${CHATWOOT_BASE_URL}/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/toggle_status`;
    logger(`Making API request to: ${url}`);
    const response = await axios.post(
      url,
      {
        status: 'open'
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'api_access_token': CHATWOOT_API_KEY
        }
      }
    );
    logger(`Conversation ${conversationId} opened successfully. Response: ${JSON.stringify(response.data)}`);
    return true;
  } catch (error) {
    logger(`Error opening conversation ${conversationId}: ${error.message}`, 'ERROR');
    if (error.response) {
      logger(`API response: ${error.response.status} - ${JSON.stringify(error.response.data)}`, 'ERROR');
    }
    return false;
  }
}

/**
 * Assigns a conversation to the configured team via the Chatwoot API.
 *
 * @param {number} conversationId - The Chatwoot conversation ID.
 * @returns {Promise<boolean>} - True if successful, false otherwise.
 */
async function assignConversationToTeam(conversationId) {
  logger(`Assigning conversation ${conversationId} to team ${CHATWOOT_TEAM_ID}...`);
  try {
    const url = `${CHATWOOT_BASE_URL}/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/assignments`;
    logger(`Making API request to: ${url}`);
    const response = await axios.post(
      url,
      {
        team_id: CHATWOOT_TEAM_ID
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'api_access_token': CHATWOOT_API_KEY
        }
      }
    );
    logger(`Conversation ${conversationId} assigned to team ${CHATWOOT_TEAM_ID} successfully. Response: ${JSON.stringify(response.data)}`);
    return true;
  } catch (error) {
    logger(`Error assigning conversation ${conversationId} to team: ${error.message}`, 'ERROR');
    if (error.response) {
      logger(`API response: ${error.response.status} - ${JSON.stringify(error.response.data)}`, 'ERROR');
    }
    return false;
  }
}

/**
 * Processes all pending conversations older than 30 minutes.
 *
 * - Checks for conversations in the database that are still 'pending' and not yet processed.
 * - For each, confirms status via Chatwoot API.
 * - If still pending, opens the conversation and assigns it to the configured team.
 * - Marks the conversation as processed in the database with a processed_at timestamp.
 * - If status is not pending, updates the status and marks as processed.
 *
 * This function is intended to be run on a schedule (cron job).
 */
async function processPendingConversations() {
  logger('Running cron job to process pending conversations...');
  // Get current timestamp in seconds
  const currentTime = Math.floor(Date.now() / 1000);
  // 30 minutes in seconds
  const thirtyMinutesAgo = currentTime - (30 * 60);
  logger(`Current time: ${currentTime}, Checking for conversations created before: ${thirtyMinutesAgo}`);
  // Query for pending conversations older than 30 minutes
  db.all(
    `SELECT id, created_at FROM conversations 
     WHERE status = 'pending' 
     AND created_at < ? 
     AND processed = 0`,
    [thirtyMinutesAgo],
    async (err, rows) => {
      if (err) {
        logger(`Error querying database: ${err.message}`, 'ERROR');
        return;
      }
      logger(`Found ${rows.length} pending conversations to process`);
      for (const row of rows) {
        const conversationId = row.id;
        const createdAt = row.created_at;
        const minutesAgo = Math.round((currentTime - createdAt) / 60);
        logger(`Processing conversation ${conversationId} (created ${minutesAgo} minutes ago)...`);
        // Double-check the current status via API
        const currentStatus = await checkConversationStatus(conversationId);
        if (currentStatus === 'pending') {
          logger(`Conversation ${conversationId} is still pending, opening it...`);
          // Open the conversation
          const openSuccess = await openConversation(conversationId);
          if (openSuccess) {
            // Assign to team
            const assignSuccess = await assignConversationToTeam(conversationId);
            // Mark as processed in database with processed_at timestamp
            db.run(
              'UPDATE conversations SET processed = 1, status = "open", processed_at = ? WHERE id = ?', 
              [currentTime, conversationId], 
              function(err) {
                if (err) {
                  logger(`Error updating conversation ${conversationId} in database: ${err.message}`, 'ERROR');
                } else {
                  logger(`Conversation ${conversationId} marked as processed in database`);
                }
              }
            );
          }
        } else if (currentStatus && currentStatus !== 'pending') {
          // Update status in our database and mark as processed with timestamp
          db.run(
            'UPDATE conversations SET status = ?, processed = 1, processed_at = ? WHERE id = ?', 
            [currentStatus, currentTime, conversationId], 
            function(err) {
              if (err) {
                logger(`Error updating conversation ${conversationId} in database: ${err.message}`, 'ERROR');
              } else {
                logger(`Conversation ${conversationId} is already ${currentStatus}, marked as processed`);
              }
            }
          );
        } else {
          logger(`Could not determine status for conversation ${conversationId}, skipping`, 'WARNING');
        }
      }
    }
  );
}

/**
 * Cleans up processed conversations from the database that are older than the configured retention period.
 *
 * - Deletes conversations marked as processed (processed = 1) and with processed_at older than DB_CLEANUP_DAYS.
 * - Intended to be run as a daily cron job.
 */
function cleanupProcessedConversations() {
  logger('Running database cleanup for processed conversations...');
  // Get current timestamp in seconds
  const currentTime = Math.floor(Date.now() / 1000);
  // Calculate cutoff time (default: 7 days ago)
  const cleanupCutoff = currentTime - (parseInt(DB_CLEANUP_DAYS) * 24 * 60 * 60);
  logger(`Current time: ${currentTime}, Removing processed conversations from before: ${cleanupCutoff}`);
  // Delete processed conversations older than the cutoff
  db.run(
    `DELETE FROM conversations 
     WHERE processed = 1 
     AND processed_at < ?`,
    [cleanupCutoff],
    function(err) {
      if (err) {
        logger(`Error cleaning up processed conversations: ${err.message}`, 'ERROR');
      } else {
        logger(`Cleaned up ${this.changes} processed conversations from database`);
      }
    }
  );
}

/**
 * Endpoint to manually trigger processing of pending conversations.
 * Useful for testing and manual intervention.
 */
app.get('/process-now', (req, res) => {
  logger('Manual processing triggered');
  processPendingConversations();
  res.status(200).send('Processing triggered');
});

/**
 * Endpoint to manually trigger cleanup of processed conversations.
 * Useful for testing and manual intervention.
 */
app.get('/cleanup-now', (req, res) => {
  logger('Manual cleanup triggered');
  cleanupProcessedConversations();
  res.status(200).send('Cleanup triggered');
});

/**
 * Utility function to get the server's IPv4 addresses.
 * Used for logging and debugging.
 * @returns {Object} - Mapping of network interface names to arrays of IP addresses.
 */
function getServerIp() {
  const nets = require('os').networkInterfaces();
  const results = {};
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      // Skip over non-IPv4 and internal (i.e. 127.0.0.1) addresses
      if (net.family === 'IPv4' && !net.internal) {
        if (!results[name]) {
          results[name] = [];
        }
        results[name].push(net.address);
      }
    }
  }
  return results;
}

// ========== CRON JOBS ==========
/**
 * Schedules the cron job to process pending conversations every 1 minute.
 *
 * This ensures conversations are handled promptly.
 */
const processCronJob = cron.schedule('*/1 * * * *', processPendingConversations);
logger('Processing cron job scheduled to run every 1 minutes');

/**
 * Schedules the cron job to clean up processed conversations daily at midnight.
 *
 * This keeps the database size manageable and removes old data.
 */
const cleanupCronJob = cron.schedule('0 0 * * *', cleanupProcessedConversations);
logger('Cleanup cron job scheduled to run daily at midnight');

// ========== SERVER STARTUP ==========
app.listen(PORT, () => {
  const serverIp = getServerIp();
  logger(`Server running on port ${PORT}`);
  logger(`Server IP addresses: ${JSON.stringify(serverIp)}`);
  logger(`Webhook URL: http://<YOUR_SERVER_IP_OR_DOMAIN>:${PORT}/webhook/chatwoot`);
  logger(`Health check: http://<YOUR_SERVER_IP_OR_DOMAIN>:${PORT}/health`);
  logger(`Database debug: http://<YOUR_SERVER_IP_OR_DOMAIN>:${PORT}/debug/db`);
  logger(`Manual processing: http://<YOUR_SERVER_IP_OR_DOMAIN>:${PORT}/process-now`);
  logger(`Manual cleanup: http://<YOUR_SERVER_IP_OR_DOMAIN>:${PORT}/cleanup-now`);
  // Validate environment variables for production safety
  if (!CHATWOOT_API_KEY) {
    logger('CHATWOOT_API_KEY is not set in .env file', 'ERROR');
  }
  if (!CHATWOOT_ACCOUNT_ID) {
    logger('CHATWOOT_ACCOUNT_ID is not set in .env file', 'ERROR');
  }
  if (!CHATWOOT_TEAM_ID) {
    logger('CHATWOOT_TEAM_ID is not set in .env file', 'ERROR');
  }
  logger(`Environment configuration:`);
  logger(`- CHATWOOT_BASE_URL: ${CHATWOOT_BASE_URL}`);
  logger(`- CHATWOOT_ACCOUNT_ID: ${CHATWOOT_ACCOUNT_ID || 'NOT SET'}`);
  logger(`- CHATWOOT_TEAM_ID: ${CHATWOOT_TEAM_ID || 'NOT SET'}`);
  logger(`- CHATWOOT_API_KEY: ${CHATWOOT_API_KEY ? '********' : 'NOT SET'}`);
  logger(`- DB_CLEANUP_DAYS: ${DB_CLEANUP_DAYS}`);
});