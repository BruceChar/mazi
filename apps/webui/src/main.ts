import { createApp } from 'vue';
import App from './App.vue';
import './style/index.css';

const root = document.getElementById('app');
if (root) {
    createApp(App).mount(root);
}
