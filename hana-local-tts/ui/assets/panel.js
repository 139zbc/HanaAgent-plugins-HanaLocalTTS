import { hana } from './sdk.js';

await hana.ready();
document.getElementById('startup-status').textContent = '助手消息下方有「朗读」。声音和语速在设置里的「本地语音朗读」。';
