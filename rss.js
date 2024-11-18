const request = require('request');
const Parser = require('rss-parser');
const fs = require('fs');
const path = require('path');
const yargs = require('yargs');

// 解析命令行参数
const argv = yargs
    .option('u', {
        alias: 'url',
        describe: 'RSS feed URL',
        type: 'string',
        default: 'https://news.ycombinator.com/rss'
    })
    .option('h', {
        alias: 'help',
        describe: '显示帮助信息',
        type: 'boolean'
    })
    .help()
    .argv;

// 创建RSS解析器
const parser = new Parser();

async function fetchRSS(url) {
    return new Promise(function(resolve, reject) {
        request(url, function(error, response, body) {
            if (error) {
                reject(error);
                return;
            }
            if (response.statusCode !== 200) {
                reject(new Error(`HTTP Status Code: ${response.statusCode}`));
                return;
            }
            resolve(body);
        });
    });
}

async function parseRSS(rssContent) {
    try {
        const feed = await parser.parseString(rssContent);
        return {
            title: feed.title,
            description: feed.description,
            items: feed.items.map(item => ({
                title: item.title,
                link: item.link,
                pubDate: item.pubDate,
                at: new Date(item.pubDate).getTime()/1000,
                content: item.content || item.contentSnippet
            }))
        };
    } catch (error) {
        throw new Error(`解析RSS失败: ${error.message}`);
    }
}

async function loadRss(url) {
    const content = await fetchRSS(url);
    const parsed = await parseRSS(content);
    return parsed;
}

async function main() {
    try {
        // 使用新的loadRss函数
        const parsedData = await loadRss(argv.url);
        
        // 输出JSON格式的结果
        console.log(JSON.stringify(parsedData, null, 2));
        
    } catch (error) {
        console.error('处理RSS时发生错误:', error.message);
        process.exit(1);
    }
}

// 当直接运行文件时执行main函数
if (require.main === module) {
    main();
}

// 导出函数供其他模块使用
module.exports = {
    loadRss
};
