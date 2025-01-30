const express = require('express');
const { Pool } = require('pg');
const axios = require('axios');
const dotenv = require('dotenv');
const cors = require('cors');

// Slack integration
const { createEventAdapter } = require('@slack/events-api');
const { WebClient } = require('@slack/web-api');
const { query } = require('express');

const aiPrompt = `
                    The vm_simple_measures view has the following fields:
                    - id: integer
                    - measurement: string (name of the measurement)
                    - clinic_id: integer
                    - clinic_name: string
                    - public_patient_id: integer
                    - first_name: string
                    - last_name: string
                    - evaluation_date_time: timestamp
                    - answer_value: numeric (the value of the measurement)

                    Based on this structure, generate a SQL query based on the question at the very end of this prompt.
                    ONLY provide the SQL, nothing else, no headers, no human commentary and no "sql" with tick marks.
                    Dates and times provided should be in a short friendly format.
                    The questions may ask about averages, trends, specific measurements, measurements across all patients, etc.
                    The measurement field contains the name of the measurement, so openai will need to understand how to find the best match when the exact match may not exist.
                    Calculate a running_avg column if needed.
                    If the question is about a trend, show the trend in the data.
                    Use ILIKE statements in the measurement field with prefix % and suffix % so partial matching works.
                    For all measurements, also provide the date and time.
                    Make sure all fields not used in aggregate queries (when using an aggregate) appear in the GROUP BY clause.
                    Always use an order by clause!
                    The question is: `;

// Configure the environment, start the express server
dotenv.config();
const app = express();

// Register slack - needs to be done before other parsing is registered
const slackSigningSecret = process.env.SLACK_SIGNING_SECRET;
const botToken = process.env.SLACK_BOT_TOKEN;
const slackEvents = createEventAdapter(slackSigningSecret);
const slackClient = new WebClient(botToken);
app.use('/slack/events', slackEvents.expressMiddleware());

// Let's be unsecured.
app.use(cors({
    origin: '*', // Replace with your React app's URL
    methods: ['GET', 'POST'], // Adjust the allowed methods if necessary
    credentials: true, // If you need to include cookies in the requests
}));

app.use(express.json());

// PostgreSQL pool connection setup
const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_DATABASE,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

// Set up openAI. We will send it info about our view's fields so it can come up with queries.
// This approach could be expanded to allow for injection of prompts so that any datasource could
// be used to answer questions.
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_API_URL = `https://api.openai.com/v1/chat/completions`;

// Slack bot id, populated on start
let botUserId;

// POST endpoint to handle questions from a basic HTTP POST
app.post('/ask', async (req, res) => {
    const { question } = req.body;
    try {
        let answer = await queryDatabase(question);
        res.json(answer);
    } catch (error) {
        console.error('Error processing the request:', error);
        res.status(500).send('Server Error');
    }
});

async function queryDatabase(question) {
    try {
        // Use OpenAI to generate SQL query
        const gptResponse = await axios.post(OPENAI_API_URL, {
            model: 'gpt-4',
            messages: [{
                role: 'user',
                content: aiPrompt + question
            }],
        }, {
            headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}` },
        });

        // Should check for nulls here, etc. WIP
        console.log('response', gptResponse.data.choices[0].message.content);
        const sqlQuery = gptResponse.data.choices[0].message.content;
        const results = await pool.query(sqlQuery);

        // Send the results back. Not jsonified yet.
        return results.rows;
    } catch (error) {
        console.error('Error processing the request:', error);
        throw error;
    }
}

// BEGIN Slack event handling

// Asynchronously harvest bot user ID at server startup
async function obtainBotUserId() {
  try {
    const response = await slackClient.auth.test();
    return response.user_id;
  } catch (error) {
    console.error('Error fetching bot user ID:', error);
  }
}

obtainBotUserId().then(id => {
  botUserId = id;
  console.log(`Bot User ID is ${botUserId}`);
});

// Integrate Slack events as middleware
app.use('/slack/events', slackEvents.expressMiddleware());

// Event handling
slackEvents.on('app_mention', async (event) => {
  try {
    console.log(`Bot mentioned in channel ${event.channel} by user ${event.user}, message was ${event}`);

    const responseText = `<@${event.user}>: Here is the data you requested... `;

    await slackClient.chat.postMessage({
      channel: event.channel,
      text: responseText + '```' + await queryDatabase(event.message) + '```',
    });
  } catch (error) {
    console.error('Error responding to mention:', error);
  }
});

slackEvents.on('error', console.error);

// END of Slack stuff

// Get the server going.
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});