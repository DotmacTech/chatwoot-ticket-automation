# Chatwoot Ticket Automation

A professional automation backend for managing Chatwoot conversations, ticket assignment, and database cleanup. This project is designed for reliability, maintainability, and production use in ISP/customer support environments.

## Features
- **Webhook Listener:** Receives Chatwoot webhook events for new conversations.
- **Automated Processing:** Periodically processes pending conversations, opens them, and assigns them to a team.
- **Database Management:** Stores all conversations in SQLite, tracks processing status, and cleans up old records.
- **Manual Triggers:** Endpoints for manual processing and cleanup.
- **Extensive Logging:** All actions and errors are logged to both console and file.
- **Environment Configuration:** All sensitive and deployment-specific settings are managed via `.env`.

## Environment Variables
See `.env.example` for required configuration:
- `PORT`: Port to run the server on (default: 3050)
- `CHATWOOT_API_KEY`: API key for authenticating with Chatwoot
- `CHATWOOT_ACCOUNT_ID`: Chatwoot account ID
- `CHATWOOT_TEAM_ID`: Team ID to assign conversations to
- `CHATWOOT_BASE_URL`: Base URL for Chatwoot API (e.g. `https://chat.dotmac.ng/api/v1`)
- `DB_CLEANUP_DAYS`: Days to retain processed conversations (default: 7)

## Endpoints
- `POST /webhook/chatwoot`: Receives Chatwoot webhook payloads
- `GET /health`: Health check endpoint
- `GET /debug/db`: Returns all conversations in the database
- `GET /process-now`: Manually trigger pending conversation processing
- `GET /cleanup-now`: Manually trigger database cleanup

## Cron Jobs
- **Process Pending:** Every 1 minute (can be adjusted)
- **Cleanup:** Every day at midnight

## Logging
- Logs are written to `logs/chatwoot-automation.log` and the console.

## Database
- SQLite database at `conversations.db`
- Table: `conversations` (see schema in `server.js`)

## Professional Practices
- All code is commented and follows best practices for error handling and maintainability.
- Sensitive data is never logged.

---

## Usage
1. Copy `.env.example` to `.env` and fill in your values.
2. Install dependencies: `npm install`
3. Start the server: `npm start`

---

## License
MIT

---

## Contributing
Pull requests and issues are welcome!
