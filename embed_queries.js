
// NOT currently used - postgres wasn't doing such a great job at matching the right query to my needs,
// so I figured, why not have something more intelligent figure out the query I want?

const { Client } = require('pg');
const { OpenAI } = require('openai');
require('dotenv').config();

// Database connection configuration
const client = new Client({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_DATABASE,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

// OpenAI configuration (using new API structure)
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

// Define the queries to embed
const queries = [
    {
        description: "Latest value for a specific measurement",
        query: `
            SELECT evaluation_date_time, clinic_name, first_name, last_name, answer_value
            FROM vm_simple_measures
            WHERE measurement ILIKE $1
              AND first_name = $2
              AND last_name = $3
            ORDER BY evaluation_date_time DESC
            LIMIT 1;
        `
    },
    {
        description: "Average value for a specific measurement",
        query: `
            SELECT AVG(answer_value) AS average_value, first_name, last_name
            FROM vm_simple_measures
            WHERE measurement ILIKE $1
              AND first_name = $2
              AND last_name = $3
            GROUP BY first_name, last_name;
        `
    },
    {
        description: "Maximum value for a specific measurement",
        query: `
            SELECT MAX(answer_value) AS max_value, first_name, last_name
            FROM vm_simple_measures
            WHERE measurement ILIKE $1
              AND first_name = $2
              AND last_name = $3
            GROUP BY first_name, last_name;
        `
    },
    {
        description: "Minimum value for a specific measurement",
        query: `
            SELECT MIN(answer_value) AS min_value, first_name, last_name
            FROM vm_simple_measures
            WHERE measurement ILIKE $1
              AND first_name = $2
              AND last_name = $3
            GROUP BY first_name, last_name;
        `
    },
    {
        description: "Trend of values over time (ordered by date)",
        query: `
            SELECT evaluation_date_time, answer_value, first_name, last_name
            FROM vm_simple_measures
            WHERE measurement ILIKE $1
              AND first_name = $2
              AND last_name = $3
            ORDER BY evaluation_date_time ASC;
        `
    },
    {
        description: "Trend with moving average of values over time",
        query: `
            WITH moving_avg AS (
                SELECT evaluation_date_time, 
                       answer_value, 
                       first_name, 
                       last_name,
                       AVG(answer_value) OVER (PARTITION BY first_name, last_name ORDER BY evaluation_date_time ROWS BETWEEN 2 PRECEDING AND CURRENT ROW) AS moving_avg_value
                FROM vm_simple_measures
                WHERE measurement ILIKE $1
                  AND first_name = $2
                  AND last_name = $3
            )
            SELECT evaluation_date_time, moving_avg_value, first_name, last_name
            FROM moving_avg
            ORDER BY evaluation_date_time ASC;
        `
    },
    {
        description: "Recent change in values (trend over last 5 entries)",
        query: `
            SELECT evaluation_date_time, answer_value, first_name, last_name
            FROM (
                SELECT evaluation_date_time, answer_value, first_name, last_name
                FROM vm_simple_measures
                WHERE measurement ILIKE $1
                  AND first_name = $2
                  AND last_name = $3
                ORDER BY evaluation_date_time DESC
                LIMIT 5
            ) AS recent_entries
            ORDER BY evaluation_date_time ASC;
        `
    },
    {
        description: "Maximum score for a specific measurement",
        query: `
            SELECT MAX(answer_value) AS max_score, first_name, last_name
            FROM vm_simple_measures
            WHERE measurement ILIKE $1
              AND first_name = $2
              AND last_name = $3
            GROUP BY first_name, last_name;
        `
    },
    {
        description: "Comparison of multiple measurements for a patient",
        query: `
            SELECT measurement, AVG(answer_value) AS avg_value, first_name, last_name
            FROM vm_simple_measures
            WHERE measurement IN ($1, $2, $3)  -- Example for 3 measurements
              AND first_name = $4
              AND last_name = $5
            GROUP BY measurement, first_name, last_name;
        `
    }
];

// Function to create embeddings for the queries using OpenAI
async function createEmbeddings(query) {
    try {
        const response = await openai.embeddings.create({
            model: "text-embedding-ada-002", // Use the embedding model
            input: query,
        });

        // Extract the embedding vector from the response
        return response.data[0].embedding;
    } catch (error) {
        console.error("Error generating embedding:", error);
    }
}

// Function to insert query and its embedding into PostgreSQL
async function insertQueryEmbedding(query, embedding) {
    const queryText = `
        INSERT INTO query_embeddings (query_text, embedding)
        VALUES ($1, $2);
    `;
    try {
        await client.query(queryText, [query, JSON.stringify(embedding)]);
        console.log(`Inserted query and its embedding into database: ${query}`);
    } catch (error) {
        console.error("Error inserting into database:", error);
    }
}

// Main function to process all queries and insert embeddings
async function embedQueries() {
    try {
        // Connect to the database once before processing queries
        await client.connect();

        // Process each query and generate embeddings
        for (const queryObj of queries) {
            const embedding = await createEmbeddings(queryObj.query);
            if (embedding) {
                await insertQueryEmbedding(queryObj.query, embedding);
            }
        }
    } catch (error) {
        console.error("Error embedding queries:", error);
    } finally {
        // Close the database connection after processing all queries
        await client.end();
    }
}

// Run the embedding process
embedQueries().catch((error) => {
    console.error("Error during embedding process:", error);
});
