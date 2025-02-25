#!/usr/bin/env node

require('dotenv').config();
const axios = require('axios');
const minimist = require('minimist');
const puppeteer = require('puppeteer');
const cheerio = require('cheerio');

// Load API keys from environment variables
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const GOOGLE_CX = process.env.GOOGLE_CX;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Get command-line arguments using minimist)
const args = minimist(process.argv.slice(2), {
  default: {
    'fetch-library': process.env.FETCH_LIBRARY || 'cheerio',
    'num-results': 5,
    'model': process.env.SUMMARY_MODEL || 'openai'
  }
});

console.log(args)

// Get values from parsed arguments
const fetchLibrary = args['fetch-library'];
const numResults = args['num-results'];
const model = args['model'];

// Get the query by excluding the known arguments
const query = args._.join(" "); // minimist stores the non-flag values in the `_` array

if (!query) {
  console.error('❌ Error: Please provide a search query.');
  console.log("Usage: ai-search.js 'your search query' [--model openai|gemini] [--fetch-library puppeteer|cheerio] [--num-results 5]");
  process.exit(1);
}

console.log(`🤖 Scraping the top ${numResults} search results with ${fetchLibrary} and summarizing with ${model}...\n`);

/**
 * Perform a Google Custom Search
 */
async function googleSearch(query) {
  const url = `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(query)}&key=${GOOGLE_API_KEY}&cx=${GOOGLE_CX}`;

  try {
    const response = await axios.get(url);
    const items = response.data.items || [];
    return items.slice(0, numResults).map(item => ({
      title: item.title,
      link: item.link
    }));
  } catch (error) {
    console.error('❌ Google Search Error:', error.response?.data || error.message);
    return [];
  }
}

/**
 * Fetch and extract content from a webpage using Puppeteer
 */
async function fetchPageContentWithPuppeteer(url) {
  let browser;
  try {
    browser = await puppeteer.launch();
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 10000 });

    const content = await page.evaluate(() => {
      const paragraphs = Array.from(document.querySelectorAll('p'));
      return paragraphs.map(p => p.innerText).join(' ');
    });

    // console.debug(content);
    console.debug(`  (Got ${content.length} content)`);

    return content.trim().length > 100 ? content.slice(0, 2000) : 'No meaningful content found.';
  } catch (error) {
    console.error(`❌ Failed to fetch content from ${url}:`, error.message);
    return 'Error fetching content.';
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

/**
 * Fetch and extract content from a webpage using Cheerio
 */
async function fetchPageContentWithCheerio(url) {
  try {
    const response = await axios.get(url, { signal: AbortSignal.timeout(5000) });
    const $ = cheerio.load(response.data);

    const content = $('p')
      .map((i, el) => $(el).text())
      .get()
      .join(' ');

    // console.debug(content);
    console.debug(`  (Got ${content.length} content)`);

    return content.trim().length > 100 ? content.slice(0, 2000) : 'No meaningful content found.';
  } catch (error) {
    console.error(`❌ Failed to fetch content from ${url}:`, error.message);
    return 'Error fetching content.';
  }
}

/**
 * Summarize content using OpenAI's API
 */
async function summarizeWithOpenAI(query, contents) {
  const openaiEndpoint = 'https://api.openai.com/v1/chat/completions';

  // const messages = [
  //   { role: 'system', content: 'You are an assistant that summarizes web content concisely.' },
  //   { role: 'user', content: `Summarize the following content for: "${query}"\n\n${contents.join('\n\n')}` }
  // ];

  const messages = [
    { role: 'system', content: 'You are an assistant that generates a new, comprehensive response based on provided content. Synthesize new insights while being informative and cohesive.' },
    { role: 'user', content: `Generate new content that answers the query: "${query}"\n\nHere is the information gathered from various sources:\n\n${contents.join('\n\n')}` }
  ];

  try {
    const response = await axios.post(
      openaiEndpoint,
      {
        model: 'gpt-4-turbo',
        messages: messages,
        max_tokens: 250
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    return response.data.choices[0].message.content.trim();
  } catch (error) {
    console.error('❌ OpenAI API Error:', error.response?.data || error.message);
    return 'Error generating summary.';
  }
}

/**
 * Summarize content using Google Gemini API
 */
async function summarizeWithGemini(query, contents) {
  const geminiEndpoint = "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent";

  try {
    const response = await axios.post(
      `${geminiEndpoint}?key=${GEMINI_API_KEY}`,
      {
        contents: [
          {
            role: "user",
            // parts: [{ text: `Summarize the following content for: "${query}"\n\n${contents.join('\n\n')}` }],
            parts: [{ text: `Generate new content to answer the query: "${query}" based on the following information:\n\n${contents.join('\n\n')}` }]
          }
        ]
      },
      {
        headers: {
          "Content-Type": "application/json"
        }
      }
    );

    return response.data.candidates[0]?.content?.parts[0]?.text.trim() || 'Error generating summary.';
  } catch (error) {
    console.error('❌ Google Gemini API Error:', error.response?.data || error.message);
    return 'Error generating summary.';
  }
}

/**
 * Main function to perform search, fetch content, and summarize
 */
async function main() {
  console.log(`🔍 Searching for: "${query}"...\n`);

  const searchResults = await googleSearch(query);
  if (searchResults.length === 0) {
    console.log('❌ No results found.');
    return;
  }

  console.log(`🔹 Fetching content from top ${numResults} search results...\n`);
  const contents = [];
  for (const result of searchResults) {
    console.log(`📄 Fetching content from: ${result.link}`);
    let content = '';
    
    if (fetchLibrary === 'puppeteer') {
      content = await fetchPageContentWithPuppeteer(result.link);
    } else if (fetchLibrary === 'cheerio') {
      content = await fetchPageContentWithCheerio(result.link);
    } else {
      console.error('❌ Invalid fetch library specified.');
      return;
    }

    contents.push(content);
  }

  console.log(`\n📝 Generating summary using ${model.toUpperCase()}...\n`);
  let summary = '';
  const instructions = `${query} -- if there is nothing useful to say, simply say "No results."`
  if (model === 'gemini') {
    summary = await summarizeWithGemini(query, contents);
  } else {
    summary = await summarizeWithOpenAI(query, contents);
  }

  console.log('\n📌 Summary:\n', summary);
}

// Run the main function
main();
