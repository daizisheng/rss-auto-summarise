const fs = require('fs');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const OpenAI = require("openai");
const tiktoken = require('tiktoken');

function readFileOrValue(value) {
    if (!value.startsWith('@')) {
        return value;
    }

    const filePath = value.substring(1);
    if (filePath === 'stdin') {
        return fs.readFileSync(0, 'utf-8').trim();
    }

    const content = fs.readFileSync(filePath, 'utf-8').trim();
    if (!content) {
        throw new Error(`File ${filePath} is empty`);
    }
    return content;
}

// Cache encoding objects for each model
const encodingCache = {};

function tokenize(text, model) {
    //const start = Date.now();
    
    // Get or create encoding for model
    if (!encodingCache[model]) {
        encodingCache[model] = tiktoken.encoding_for_model(model);
    }
    const encoding = encodingCache[model];
    
    const tokens = encoding.encode(text);
    const count = tokens.length;
    
    //const timeCost = Date.now() - start;
    //console.error(`Tokenize time cost: ${timeCost}ms`);
    return {
        tokens: tokens,
        count: count
    };
}

function getModelMaxTokens(model) {
    // Known model context lengths
    const modelLimits = {
        'gpt-4o-mini': 128000
    };

    if (model in modelLimits) {
        return modelLimits[model];
    }

    throw new Error(`Unknown model ${model}. Cannot determine maximum context length.`);
}

async function callOpenAI(apiKey, model, content) {
    try {
        // Check token count
        const maxTokens = getModelMaxTokens(model);
        const tokenInfo = tokenize(content, model);
        if (tokenInfo.count > maxTokens - 10) {
            throw new Error(`Content length (${tokenInfo.count} tokens) exceeds maximum allowed tokens (${maxTokens - 10})`);
        }

        const openai = new OpenAI({apiKey: apiKey});
        const response = await openai.chat.completions.create({
            model: model,
            messages: [{
                role: "user", 
                content: content
            }]
        });
        
        if (!response.choices || !response.choices[0] || !response.choices[0].message) {
            throw new Error("Invalid response from OpenAI API");
        }

        return response.choices[0].message.content;
    } catch (error) {
        throw new Error(`OpenAI API调用失败: ${error.message}`);
    }
}

async function summarizeWithChatGPT(apiKey, content, model, localChunkSize, delimiter, verbose) {
    // Split content into lines and get token info for each line
    if(verbose) {
        console.log(`Splitting content into lines with delimiter [${delimiter}]`);
    }
    const lines = content.split(delimiter || '\n');
    if(verbose) {
        console.log(`Splitted into ${lines.length} lines`);
    }
    const lineInfos = lines.map(line => {
        const info = tokenize(line, model);
        return {
            content: line,
            tokens: info.tokens,
            count: info.count
        };
    });

    if (verbose) {
        const totalTokens = lineInfos.reduce((sum, info) => sum + info.count, 0);
        console.log(`Parsed ${lines.length} lines with delimiter ${delimiter}, total tokens: ${totalTokens}`);
    }

    // Get max tokens for this model
    const maxTokens = getModelMaxTokens(model);
    if (!maxTokens) {
        throw new Error(`Unknown model ${model}`);
    }
    // Assemble lines into chunks based on token count
    const chunks = [];
    let currentChunk = [];
    let currentTokenCount = 0;

    for (const lineInfo of lineInfos) {
        // If adding this line would exceed chunk size, start a new chunk
        if (currentTokenCount + lineInfo.count > localChunkSize && currentChunk.length > 0) {
            chunks.push({
                content: currentChunk.join(delimiter),
                tokenCount: currentTokenCount
            });
            currentChunk = [];
            currentTokenCount = 0;
        }

        // If current line is too long, split it into a new chunk
        if (lineInfo.count > maxTokens - 1000) {
            if (currentChunk.length > 0) {
                chunks.push({
                    content: currentChunk.join(delimiter),
                    tokenCount: currentTokenCount
                });
                currentChunk = [];
                currentTokenCount = 0;
            }
            chunks.push({
                content: "...",
                tokenCount: 3  // "..." is typically 3 tokens
            });
            continue;
        }

        // Add line to current chunk
        currentChunk.push(lineInfo.content);
        currentTokenCount += lineInfo.count;
    }

    // Add final chunk if not empty
    if (currentChunk.length > 0) {
        chunks.push({
            content: currentChunk.join(delimiter),
            tokenCount: currentTokenCount
        });
    }

    // Summarize chunks sequentially, using previous summaries as context
    const summaries = [];
    let previousSummary = '';

    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        // Build prompt with previous summary as context
        let promptText = '';
        if (previousSummary) {
            promptText = `Previous summary:\n${previousSummary}\n\nPlease continue summarizing the following content, taking the previous summary into account:\n\n`;
        } else {
            promptText = `Please summarize the following content:\n\n`;
        }

        if (verbose) {
            console.error(`--- Chunk ${i + 1}/${chunks.length} (${chunk.tokenCount} tokens)`);
        }

        // Call OpenAI API to summarize this chunk
        const summary = await callOpenAI(apiKey, model, promptText + "\n\n" + chunk.content);

        if (verbose) {
            console.error(`--- Chunk ${i + 1}/${chunks.length} Summary ---\n${summary}`);
        }

        summaries.push(summary);
        previousSummary = summary;
    }

    // Join all summaries with newlines
    return summaries.join("\n\n");
}

async function main() {
    const argv = yargs(hideBin(process.argv))
        .option('k', {
            alias: 'api-key',
            type: 'string',
            default: '@/etc/chatgpt.key',
            description: 'OpenAI API key or file path starting with @'
        })
        .option('c', {
            alias: 'content',
            type: 'string',
            default: '@stdin',
            description: 'Content to summarize or file path starting with @'
        })
        .option('m', {
            alias: 'model',
            type: 'string',
            default: 'gpt-4o-mini',
            description: 'OpenAI model to use'
        })
        .option('s', {
            alias: 'chunk-size',
            type: 'number',
            default: 100000,
            description: 'Maximum tokens per chunk'
        })
        .option('d', {
            alias: 'delimiter',
            type: 'string',
            default: '\n',
            description: 'Delimiter to split content into chunks'
        })
        .option('v', {
            alias: 'verbose',
            type: 'boolean',
            default: false,
            description: 'Print intermediate summaries'
        })
        .option('h', {
            alias: 'help',
            type: 'boolean',
            description: 'Show help'
        })
        .help()
        .parse();

    try {
        const apiKey = readFileOrValue(argv['api-key']);
        const content = readFileOrValue(argv.content);
        const model = argv.model;
        const chunkSize = argv['chunk-size'];
        const delimiter = argv.delimiter;
        const verbose = argv.verbose;

        const summary = await summarizeWithChatGPT(apiKey, content, model, chunkSize, delimiter, verbose);
        console.log(summary);
    } catch (error) {
        console.error('Error:', error.message);
        console.error('Stack:', error.stack);
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}

module.exports = {
    summarizeWithChatGPT,
    readFileOrValue
};
