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
                    The 'vm_simple_measures' view contains the following fields:
                    - 'id': integer
                    - 'measurement': string (name of the measurement)
                    - 'clinic_id': integer
                    - 'clinic_name': string
                    - 'public_patient_id': integer
                    - 'first_name': string
                    - 'last_name': string
                    - 'evaluation_date_time': timestamp
                    - 'answer_value': numeric (the value of the measurement) is double precision do not use in rounding

                    The 'vw_patients' view constains the following fields:
                    - 'public_patient_id'
                    - 'patient_id'
                    - 'patient_key'
                    - 'evaluation_count'
                    - 'last_name'
                    - 'first_name'
                    - 'clinic_name'
                    - 'dob'
                    - 'clinic_id'
                    - 'zip'
                    - 'sex'
                    - 'date_started'

                    Instructions for generating a SQL query based on the question at the end:
                    - Do not use single quotes around field names, view names or table names
                    - Based on the question, query one or both views described. Join if necessary
                    - If asking about measurements, vm_simple_measures is appropriate.
                    - If asking about patient info without measurements, use vw_patients
                    - Output only the SQL query without headers, human commentary, or tick marks.
                    - Use '%' wildcards with 'ILIKE' for partial matching in the 'measurement' field.
                    - Include 'DISTINCT' to ensure unique results.
                    - All non-aggregated fields should be in the 'GROUP BY' clause for aggregate queries.
                    - Do not use LAG and HAVING clauses in combination
                    - Always include an 'ORDER BY' clause.
                    - Convert dates and times to a short, friendly format.
                    - Include a 'running_avg' column if calculating an average over time.
                    - If the query involves trends, ensure the SQL reflects this.
                    - Provide 'evaluation_date_time' for each measurement.
                    - Remove script commentary and tick marks. Only return SQL
                    - IMPORTANT: Do not include explanations, comments, or annotations—return only the SQL query.
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

    console.log("Question asked was", question);

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

// Message conversion - from generic JSON to Block Kit formatting in Slack
function convertJsonToSlackBlocks(jsonData) {
  if (!Array.isArray(jsonData) || jsonData.length === 0) {
    throw new Error("JSON data should be a non-empty array.");
  }
  const blocks = [];

  jsonData.forEach((data, index) => {
    const section = {
      type: 'section',
      fields: [],
    };

    Object.entries(data).forEach(([key, value]) => {
      const formattedKey = key.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
      let formattedValue;

      if (key.toLowerCase().includes('date') || key.toLowerCase().includes('time')) {
        try {
          const date = new Date(value);
          const unixTimestamp = Math.floor(date.getTime() / 1000);
          formattedValue = `<!date^${unixTimestamp}^{date_short_pretty} at {time}|${value}>`;
        } catch (error) {
          formattedValue = value.toString();
        }
      } else {
        formattedValue = value.toString();
      }

      section.fields.push({
        type: 'mrkdwn',
        text: `*${formattedKey}:*\n${formattedValue}`,
      });
    });

    // Adding a divider between different entries, optional
    if (index > 0) {
      blocks.push({ type: 'divider' });
    }

    blocks.push(section);
  });

  return { blocks };
}

// Event handling
slackEvents.on('app_mention', async (event) => {
  try {
    console.log(`Bot mentioned in channel ${event.channel} by user ${event.user}, message was ${event.text}`);

    // const responseText = `<@${event.user}>: `;

    await queryDatabase(event.text).then(data => {
      console.log('Data returned was', data);

      if(data && data.length > 0) {
        const slackBlockMessage = convertJsonToSlackBlocks(data);

        slackClient.chat.postMessage({
          channel: event.channel,
          blocks: slackBlockMessage.blocks,
          text: 'Data found, please use the slack web, desktop or mobile client.'
        });
      } else {
        slackClient.chat.postMessage({
          channel: event.channel,
          text: 'No data found'
        });
      }
    });


  } catch (error) {
    console.error('Error responding:', error);
  }
});

slackEvents.on('error', console.error);

// END of Slack stuff

// Get the server going.
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});