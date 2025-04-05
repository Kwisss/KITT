document.addEventListener('DOMContentLoaded', () => {
    const DEFAULT_FILE_CONTEXT_INTRO = "I'm going to reference some files. Please consider these in your response:"; 
    const state = {
        selectedFiles: [],
        isStreaming: false,
        uploadInProgress: false,
        saveTimeout: null,
        currentThreadId: null,
        renameThreadId: null,
        abortController: null,
        systemPrompt: localStorage.getItem('systemPrompt') || 'You are a helpful assistant.',
        fileContextIntro: localStorage.getItem('fileContextIntro') || DEFAULT_FILE_CONTEXT_INTRO,
        appendFileContext: JSON.parse(localStorage.getItem('appendFileContext') || 'false'), 
        currentHistory: [],
        temporaryHistory: [],
    };
    const elements = {
        modelDropdown: document.getElementById('model-dropdown'),
        messageInput: document.getElementById('message-input'),
        sendButton: document.getElementById('send-button'),
        chatMessages: document.getElementById('chat-messages'),
        chatContainer: document.querySelector('.chat-container'),
        selectedFilesDisplay: document.getElementById('selected-files-display'),
        fileInput: document.getElementById('file'),
        uploadFilesBtn: document.getElementById('upload-files-btn'),
        uploadStatus: document.getElementById('upload-status'),
        filesContainer: document.getElementById('files-container'),
        clearConversationBtn: document.getElementById('clear-conversation'),
        settingsButton: document.getElementById('settings-button'),
        settingsModal: document.getElementById('settings-modal'),
        systemPromptInput: document.getElementById('system-prompt-input'),
        saveStatusDiv: document.getElementById('save-status'),
        fileContextIntroInput: document.getElementById('file-context-intro-input'),
        appendFileContextSwitch: document.getElementById('append-file-context-switch'),
        newThreadBtn: document.getElementById('new-thread-btn'),
        threadsContainer: document.getElementById('threads-container'),
        renameThreadModal: document.getElementById('rename-thread-modal'),
        threadNameInput: document.getElementById('thread-name-input'),
        cancelRenameBtn: document.getElementById('cancel-rename-btn'),
        confirmRenameBtn: document.getElementById('confirm-rename-btn'),
        topMessageInserter: null,
    };
    const WELCOME_MESSAGE_HTML = `
        <div class="welcome-message">
            <h2>Welcome to KITT!</h2>
            <p>Select a model from the dropdown, optionally Drag and drop files to reference, and start chatting.</p>
            <p>-</p>
            <p>The settings button located next to the send buton is where you can set a system prompt and a reference prompt/settings</p>
        </div>`;
    const SHORT_MESSAGE_THRESHOLD = 100;
    const api = {
        async _fetchAPI(url, options = {}) {
            const defaultHeaders = {
                'Accept': 'application/json',
                ...(options.body && !(options.body instanceof FormData) && { 'Content-Type': 'application/json' }),
            };
            try {
                const response = await fetch(url, {
                    ...options,
                    headers: {
                        ...defaultHeaders,
                        ...options.headers,
                    },
                    credentials: 'include',
                });
                if (!response.ok) {
                    let errorData;
                    try {
                        errorData = await response.json();
                    } catch (e) {
                        errorData = { error: await response.text() || `HTTP error! status: ${response.status}` };
                    }
                    console.error(`API Error (${response.status}) for ${url}:`, errorData);
                    return { success: false, error: errorData.error || `HTTP ${response.status}` };
                }
                if (response.status === 204) {
                    return { success: true, data: null };
                }
                const data = await response.json();
                return { success: true, data };
            } catch (error) {
                console.error(`Network or fetch error for ${url}:`, error);
                return { success: false, error: error.message || 'Network error' };
            }
        },
        async fetchModels() {
            const result = await this._fetchAPI('/api/models');
            if (result.success && result.data) {
                ui.displayModels(result.data);
            } else {
                console.error("Failed to fetch models:", result.error);
                ui.displayModels([]);
            }
            return result;
        },
        async fetchFiles() {
            const result = await this._fetchAPI('/api/files');
            if (result.success && result.data) {
                ui.displayFiles(result.data);
            } else {
                console.error("Failed to fetch files:", result.error);
                ui.displayFiles([]);
            }
            return result;
        },
        async fetchThreads() {
            const result = await this._fetchAPI('/api/threads');
            if (result.success && result.data) {
                ui.displayThreads(result.data.threads || [], result.data.active_thread);
                if (state.currentThreadId === null && result.data.active_thread) {
                    state.currentThreadId = result.data.active_thread;
                    console.log("Initial active thread ID set from backend:", state.currentThreadId);
                }
            } else {
                console.error("Failed to fetch threads:", result.error);
                ui.displayThreads([], null);
            }
            return result;
        },
        async fetchConversationHistory() {
            if (!state.currentThreadId) {
                console.warn("Attempted to fetch history with no active thread ID.");
                state.currentHistory = [];
                state.temporaryHistory = [];
                ui.renderMessages(state.temporaryHistory);
                return { success: false, error: "No active thread ID" };
            }
            console.log(`Fetching history for thread: ${state.currentThreadId}`);
            const result = await this._fetchAPI('/api/conversation/history');
            if (result.success && result.data) {
                 if (result.data.thread_id !== state.currentThreadId) {
                     console.warn(`History received for thread ${result.data.thread_id}, but expected ${state.currentThreadId}. State mismatch? Correcting state.`);
                     state.currentThreadId = result.data.thread_id;
                     await api.fetchThreads();
                 }
                 state.currentHistory = result.data.history || [];
                 state.temporaryHistory = JSON.parse(JSON.stringify(state.currentHistory));
                 console.log("Fetched and set history. Current:", state.currentHistory.length, "Temp:", state.temporaryHistory.length);
                 ui.renderMessages(state.temporaryHistory);
            } else {
                console.error("Failed to fetch conversation history:", result.error);
                state.currentHistory = [];
                state.temporaryHistory = [];
                ui.renderMessages(state.temporaryHistory);
            }
            return result;
        },
        async deleteFile(filename) {
            return await this._fetchAPI(`/api/files/${filename}`, { method: 'DELETE' });
        },
        async clearConversation() {
            return await this._fetchAPI('/api/conversation/clear', { method: 'POST' });
        },
        async createNewThread() {
            return await this._fetchAPI('/api/threads/new', { method: 'POST' });
        },
        async activateThread(threadId) {
            return await this._fetchAPI(`/api/threads/${threadId}/activate`, { method: 'POST' });
        },
        async renameThread(threadId, newName) {
            return await this._fetchAPI(`/api/threads/${threadId}/rename`, {
                method: 'POST',
                body: JSON.stringify({ name: newName }),
            });
        },
        async deleteThread(threadId) {
            return await this._fetchAPI(`/api/threads/${threadId}/delete`, { method: 'DELETE' });
        },
        async generateTitle(conversationData) {
            return await this._fetchAPI('/api/generate-title', {
                method: 'POST',
                body: JSON.stringify(conversationData),
            });
        },
    };
    const ui = {
        displayModels(models) {
            elements.modelDropdown.innerHTML = '';
            if (!models || models.length === 0) {
                const option = document.createElement('option');
                option.value = "";
                option.textContent = "No models available";
                elements.modelDropdown.appendChild(option);
                elements.modelDropdown.disabled = true;
                return;
            }
            elements.modelDropdown.disabled = false;
            models.forEach(model => {
                const option = document.createElement('option');
                option.value = model.name;
                option.textContent = model.name;
                elements.modelDropdown.appendChild(option);
            });
            if (elements.modelDropdown.options.length > 0) {
                elements.modelDropdown.selectedIndex = 0;
            }
        },
        displayFiles(files) {
            elements.filesContainer.innerHTML = '';
            if (!files || files.length === 0) {
                elements.filesContainer.innerHTML = '<p>No files uploaded yet.</p>';
                return;
            }
            files.forEach(filename => {
                const fileItem = document.createElement('div');
                fileItem.className = 'file-item';
                fileItem.dataset.filename = filename;
                const fileNameDiv = document.createElement('div');
                fileNameDiv.className = 'file-name';
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.id = `file-${filename}`;
                checkbox.dataset.filename = filename;
                checkbox.className = 'file-checkbox';
                checkbox.checked = state.selectedFiles.includes(filename);
                const label = document.createElement('label');
                label.htmlFor = `file-${filename}`;
                label.textContent = filename;
                const deleteBtn = document.createElement('button');
                deleteBtn.className = 'delete-btn';
                deleteBtn.innerHTML = '<i class="fas fa-trash"></i>';
                deleteBtn.title = `Delete ${filename}`;
                fileNameDiv.append(checkbox, label);
                fileItem.append(fileNameDiv, deleteBtn);
                elements.filesContainer.appendChild(fileItem);
            });
        },
        updateSelectedFilesDisplay() {
            elements.selectedFilesDisplay.innerHTML = '';
            if (state.selectedFiles.length === 0) {
                 elements.selectedFilesDisplay.style.display = 'none';
                 return;
            }
            elements.selectedFilesDisplay.style.display = 'flex';
            state.selectedFiles.forEach(filename => {
                const fileTag = document.createElement('div');
                fileTag.className = 'selected-file-tag';
                fileTag.dataset.filename = filename;
                const fileNameSpan = document.createElement('span');
                fileNameSpan.textContent = filename;
                const removeButton = document.createElement('button');
                removeButton.className = 'remove-file';
                removeButton.innerHTML = '×';
                removeButton.title = `Remove ${filename} from selection`;
                fileTag.append(fileNameSpan, removeButton);
                elements.selectedFilesDisplay.appendChild(fileTag);
            });
        },
        displayThreads(threads, activeThreadId) {
            elements.threadsContainer.innerHTML = '';
            if (!threads || threads.length === 0) {
                elements.threadsContainer.innerHTML = '<p class="no-threads-message">No threads yet</p>';
                return;
            }
            threads.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
            threads.forEach(thread => {
                const threadItem = document.createElement('div');
                threadItem.className = 'thread-item';
                threadItem.dataset.threadId = thread.id;
                if (thread.id === activeThreadId) {
                    threadItem.classList.add('active');
                }
                const threadName = document.createElement('div');
                threadName.className = 'thread-name';
                threadName.textContent = thread.name || 'Untitled Thread';
                threadName.title = thread.name || 'Untitled Thread';
                const threadOptions = document.createElement('div');
                threadOptions.className = 'thread-options';
                const renameBtn = document.createElement('button');
                renameBtn.className = 'thread-option-btn rename-btn';
                renameBtn.innerHTML = '<i class="fas fa-edit"></i>';
                renameBtn.title = 'Rename thread';
                const deleteBtn = document.createElement('button');
                deleteBtn.className = 'thread-option-btn delete-btn';
                deleteBtn.innerHTML = '<i class="fas fa-trash"></i>';
                deleteBtn.title = 'Delete thread';
                threadOptions.append(renameBtn, deleteBtn);
                threadItem.append(threadName, threadOptions);
                elements.threadsContainer.appendChild(threadItem);
            });
        },
        renderMessages(messagesToRender) {
            console.log(`Rendering ${messagesToRender.length} messages from temporary history.`);
            this.clearChatMessagesAndInserters();
            if (!messagesToRender || messagesToRender.length === 0) {
                this.addWelcomeMessage();
            } else {
                messagesToRender.forEach((msg, index) => {
                    if (!msg || typeof msg.role !== 'string') {
                        console.warn(`Skipping rendering invalid message at index ${index}:`, msg);
                        return;
                    }
                    const sender = msg.role === 'assistant' ? 'bot' : msg.role;
                    const messageWrapperElement = this.createMessageElement(
                        msg.content,
                        sender,
                        msg.thinking || null,
                        msg.id,
                        index,
                        msg.referencedFiles || null
                    );
                    const inserterElement = this.createMessageInserter(msg.id, index);
                    elements.chatMessages.appendChild(messageWrapperElement);
                    elements.chatMessages.appendChild(inserterElement);
                    this.processMessageContent(messageWrapperElement);
                });
            }
            if (!state.isStreaming) {
                this.scrollToBottom();
            }
        },
        clearChatMessagesAndInserters() {
            const messagesToRemove = elements.chatMessages.querySelectorAll('.message-wrapper, .message-inserter:not(#top-message-inserter)');
            messagesToRemove.forEach(el => el.remove());
            const welcome = elements.chatMessages.querySelector('.welcome-message');
            if (welcome) welcome.remove();
            console.log("Cleared message wrappers and inserters.");
        },
        addWelcomeMessage() {
            if (!elements.chatMessages.querySelector('.message')) {
                elements.chatMessages.insertAdjacentHTML('beforeend', WELCOME_MESSAGE_HTML);
            }
        },
        createMessageElement(content, sender, thinking, messageId, index, referencedFiles) {
            const messageWrapper = document.createElement('div');
            messageWrapper.className = `message-wrapper ${sender}`;
            const idToUse = typeof messageId === 'string' && messageId ? messageId : `temp-${sender}-${index}-${Date.now()}`;
            messageWrapper.dataset.messageId = idToUse;
            messageWrapper.dataset.messageIndex = index;
            const messageDiv = document.createElement('div');
            messageDiv.className = `message ${sender}`;
            const contentDiv = document.createElement('div');
            contentDiv.className = 'message-content';
            if (sender === 'bot' && thinking) {
                const thinkingDiv = document.createElement('div');
                thinkingDiv.className = 'thinking-section';
                const thinkingToggle = document.createElement('button');
                thinkingToggle.className = 'thinking-toggle';
                thinkingToggle.textContent = 'Show thinking';
                const thinkingContent = document.createElement('div');
                thinkingContent.className = 'thinking-content';
                thinkingContent.style.display = 'none';
                thinkingContent.innerHTML = this.formatMessage(thinking);
                thinkingToggle.addEventListener('click', () => {
                    const isHidden = thinkingContent.style.display === 'none';
                    thinkingContent.style.display = isHidden ? 'block' : 'none';
                    thinkingToggle.textContent = isHidden ? 'Hide thinking' : 'Show thinking';
                    if (isHidden) thinkingContent.querySelectorAll('pre code').forEach(this.highlightElement);
                });
                thinkingDiv.append(thinkingToggle, thinkingContent);
                contentDiv.appendChild(thinkingDiv);
            }
            const bodyDiv = document.createElement('div');
            bodyDiv.className = 'message-body';
            bodyDiv.innerHTML = this.formatMessage(content || '');
            contentDiv.appendChild(bodyDiv);
            messageDiv.appendChild(contentDiv);
            if (sender === 'user' && referencedFiles && referencedFiles.length > 0) {
                const filesDiv = document.createElement('div');
                filesDiv.className = 'referenced-files';
                filesDiv.innerHTML = `<span class="ref-label">Referenced files:</span> ${referencedFiles.join(' ')}`;
                messageDiv.appendChild(filesDiv);
            }
            const actionsDiv = document.createElement('div');
            actionsDiv.className = 'message-actions';
            const editBtn = document.createElement('button');
            editBtn.className = 'edit-message-btn';
            editBtn.innerHTML = '<i class="fas fa-edit"></i>';
            editBtn.title = 'Edit message';
            editBtn.disabled = state.isStreaming;
            actionsDiv.appendChild(editBtn);
            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'delete-message-btn';
            deleteBtn.innerHTML = '<i class="fas fa-trash"></i>';
            deleteBtn.title = 'Delete message and subsequent history (temporary)';
            deleteBtn.disabled = state.isStreaming;
            actionsDiv.appendChild(deleteBtn);
            if (sender === 'user') {
                const resendBtn = document.createElement('button');
                resendBtn.className = 'resend-message-btn';
                resendBtn.innerHTML = '<i class="fas fa-redo"></i>';
                resendBtn.title = 'Resend from this point';
                resendBtn.disabled = state.isStreaming;
                actionsDiv.appendChild(resendBtn);
            }
            messageWrapper.appendChild(messageDiv);
            messageWrapper.appendChild(actionsDiv);
            return messageWrapper;
        },
        updateMessageElementDOM(messageWrapperElement, newContent, newThinking) {
            if (!messageWrapperElement) return;
            const messageElement = messageWrapperElement.querySelector('.message');
            if (!messageElement) return;
            const contentDiv = messageElement.querySelector('.message-content');
            const bodyDiv = messageElement.querySelector('.message-body');
             if (bodyDiv) {
                bodyDiv.innerHTML = this.formatMessage(newContent);
            } else if (contentDiv) {
                 contentDiv.innerHTML = this.formatMessage(newContent);
            }
            let thinkingDiv = messageElement.querySelector('.thinking-section');
            let thinkingContent = messageElement.querySelector('.thinking-content');
            if (newThinking !== null && newThinking !== undefined) {
                if (!thinkingDiv) {
                    thinkingDiv = document.createElement('div');
                    thinkingDiv.className = 'thinking-section';
                    const thinkingToggle = document.createElement('button');
                    thinkingToggle.className = 'thinking-toggle';
                    thinkingToggle.textContent = 'Show thinking';
                    thinkingContent = document.createElement('div');
                    thinkingContent.className = 'thinking-content';
                    thinkingContent.style.display = 'none';
                    thinkingToggle.addEventListener('click', () => {
                        const isHidden = thinkingContent.style.display === 'none';
                        thinkingContent.style.display = isHidden ? 'block' : 'none';
                        thinkingToggle.textContent = isHidden ? 'Hide thinking' : 'Show thinking';
                         if (isHidden) thinkingContent.querySelectorAll('pre code').forEach(this.highlightElement);
                    });
                    thinkingDiv.append(thinkingToggle, thinkingContent);
                    if (contentDiv && bodyDiv) {
                        contentDiv.insertBefore(thinkingDiv, bodyDiv);
                    } else if (contentDiv) {
                        contentDiv.appendChild(thinkingDiv);
                    }
                }
                thinkingContent.innerHTML = this.formatMessage(newThinking);
            } else if (thinkingDiv) {
                thinkingDiv.remove();
            }
            this.processMessageContent(messageWrapperElement);
        },
        formatMessage(content) {
            if (content === null || typeof content === 'undefined') return '';
            content = String(content);
            function escapeHTML(text) {
                const div = document.createElement('div');
                div.textContent = text;
                return div.innerHTML;
            }
            const parts = [];
            let lastIndex = 0;
            const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g;
            let match;
            while ((match = codeBlockRegex.exec(content)) !== null) {
                if (match.index > lastIndex) {
                    parts.push({ type: 'text', content: escapeHTML(content.substring(lastIndex, match.index)) });
                }
                parts.push({
                    type: 'code',
                    language: match[1] || 'plaintext',
                    content: escapeHTML(match[2])
                });
                lastIndex = match.index + match[0].length;
            }
            if (lastIndex < content.length) {
                parts.push({ type: 'text', content: escapeHTML(content.substring(lastIndex)) });
            }
            return parts.map(part => {
                if (part.type === 'code') {
                    const langTag = part.language !== 'plaintext' ? `<div class="language-tag">${part.language}</div>` : '';
                    return `${langTag}<pre><code class="language-${part.language}">${part.content}</code></pre>`;
                } else {
                    return part.content
                        .replace(/`([^`]+)`/g, (match, code) => `<code>${code}</code>`)
                        .replace(/\n/g, '<br>');
                }
            }).join('');
        },
        highlightElement(element) {
            if (window.hljs && element) {
                try { window.hljs.highlightElement(element); } catch (e) { console.error("Highlight.js error:", e, "on element:", element); }
            }
        },
        processMessageContent(messageWrapperElement) {
            if (!messageWrapperElement || !window.hljs) return;
            const codeBlocks = messageWrapperElement.querySelectorAll('.message-body pre code, .thinking-content pre code');
            codeBlocks.forEach(this.highlightElement);
        },
        adjustTextareaHeight(textarea) {
            textarea.style.height = 'auto';
            textarea.style.height = `${textarea.scrollHeight}px`;
        },
        scrollToBottom() {
            setTimeout(() => {
                elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
            }, 50);
        },
         scrollToTop() {
            elements.chatMessages.scrollTop = 0;
        },
        toggleStopButton(showStop) {
            const btn = elements.sendButton;
            if (showStop) {
                btn.innerHTML = '<i class="fas fa-stop"></i>';
                btn.title = 'Stop generation';
                btn.classList.add('stop-button');
                btn.onclick = handleStopGeneration;
            } else {
                btn.innerHTML = '<i class="fas fa-paper-plane"></i>';
                btn.title = 'Send message';
                btn.classList.remove('stop-button');
                btn.onclick = handleSendMessage;
            }
        },
        updateUploadStatus(message, statusClass) {
            elements.uploadStatus.textContent = message;
            elements.uploadStatus.className = statusClass;
        },
        updateUploadStatusFinal(successCount, errorCount, totalFiles) {
            let message = '';
            let statusClass = '';
            if (errorCount === 0 && successCount > 0) {
                message = `Successfully uploaded ${successCount} file(s).`; statusClass = 'success';
            } else if (successCount === 0 && errorCount > 0) {
                message = `Upload failed for ${errorCount} file(s).`; statusClass = 'error';
            } else if (successCount > 0 && errorCount > 0) {
                message = `Uploaded ${successCount} of ${totalFiles} files (${errorCount} failed).`; statusClass = 'warning';
            } else {
                 message = 'No files were uploaded.'; statusClass = '';
            }
            this.updateUploadStatus(message, statusClass);
            setTimeout(() => { this.updateUploadStatus('', ''); }, 4000);
        },
        showModal(modalElement) { modalElement.style.display = 'flex'; },
        hideModal(modalElement) { modalElement.style.display = 'none'; },
        createKittIndicator() {
            const existing = document.querySelector('.typing-indicator');
            if (existing) return existing;
            const wrapper = document.createElement('div');
            wrapper.className = 'typing-indicator';
            const kittDiv = document.createElement('div');
            kittDiv.className = 'typing-kitt';
            const scanner = document.createElement('div');
            scanner.className = 'scanner';
            kittDiv.appendChild(scanner);
            const numRectangles = 10; const rectWidth = (200 / numRectangles) - 1;
            for (let i = 0; i < numRectangles; i++) {
                const rect = document.createElement('div'); rect.className = 'rectangle'; rect.style.width = `${rectWidth}px`; kittDiv.appendChild(rect);
            }
            wrapper.appendChild(kittDiv);
            const animateRectangles = () => {
                if (!wrapper.isConnected) { clearInterval(wrapper.intervalId); return; }
                const kittRect = kittDiv.getBoundingClientRect(); const scannerRect = scanner.getBoundingClientRect();
                if (kittRect.width === 0 || scannerRect.width === 0) return;
                const scannerPos = scannerRect.left - kittRect.left + (scannerRect.width / 2);
                const rectangles = kittDiv.querySelectorAll('.rectangle');
                rectangles.forEach(rect => {
                    const rectRect = rect.getBoundingClientRect(); const rectCenterPos = rectRect.left - kittRect.left + (rectRect.width / 2);
                    const distance = Math.abs(scannerPos - rectCenterPos); const maxDistance = 35;
                    if (distance < maxDistance) {
                        const intensity = 1 - (distance / maxDistance); const red = Math.floor(100 + (155 * intensity));
                        rect.style.backgroundColor = `rgb(${red}, 0, 0)`; rect.style.boxShadow = `0 0 ${Math.floor(intensity * 5)}px rgba(255, 0, 0, 0.5)`;
                    } else {
                        rect.style.backgroundColor = '#600'; rect.style.boxShadow = 'none';
                    }
                });
            };
            wrapper.intervalId = setInterval(animateRectangles, 50);
            return wrapper;
        },
        hideTypingIndicator(indicatorElement) {
            if (indicatorElement && indicatorElement.intervalId) clearInterval(indicatorElement.intervalId);
            if (indicatorElement && indicatorElement.parentNode) indicatorElement.remove();
            const fallbackIndicator = document.querySelector('.typing-indicator');
            if (fallbackIndicator) { if (fallbackIndicator.intervalId) clearInterval(fallbackIndicator.intervalId); fallbackIndicator.remove(); }
        },
        createMessageInserter(precedingMessageId, precedingMessageIndex) {
            const inserterDiv = document.createElement('div');
            inserterDiv.className = 'message-inserter';
            inserterDiv.dataset.precedingMessageIndex = precedingMessageIndex ?? '';
            inserterDiv.dataset.precedingMessageId = precedingMessageId || '';
            const icon = document.createElement('i'); icon.className = 'fas fa-plus insert-icon';
            const leftArea = document.createElement('div'); leftArea.className = 'insert-area left'; leftArea.title = 'Insert Assistant message here';
            const rightArea = document.createElement('div'); rightArea.className = 'insert-area right'; rightArea.title = 'Insert User message here';
            inserterDiv.append(leftArea, rightArea, icon);
            return inserterDiv;
        },
        showNewMessageInput(inserterElement, role, precedingMessageIndex) {
            this.removeEditAndInsertInputs();
            const inputArea = document.createElement('div'); inputArea.className = 'new-message-input-area';
            const textarea = document.createElement('textarea'); textarea.placeholder = `Enter new ${role} message... (Shift+Enter for newline)`;
            const buttonsDiv = document.createElement('div'); buttonsDiv.className = 'input-buttons';
            const saveBtn = document.createElement('button'); saveBtn.textContent = `Save ${role === 'user' ? 'User' : 'Assistant'}`; saveBtn.className = `save-btn ${role}`;
            saveBtn.onclick = () => { handleSaveInsertedMessage(precedingMessageIndex, role, textarea.value.trim(), inputArea, inserterElement); };
            const cancelBtn = document.createElement('button'); cancelBtn.textContent = 'Cancel'; cancelBtn.className = 'cancel-btn';
            cancelBtn.onclick = () => { inputArea.remove(); inserterElement.classList.remove('inserting'); };
            textarea.addEventListener('keydown', e => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveBtn.click(); }
                else if (e.key === 'Escape') { cancelBtn.click(); }
            });
            buttonsDiv.append(saveBtn, cancelBtn);
            inputArea.append(textarea, buttonsDiv);
            inserterElement.parentNode.insertBefore(inputArea, inserterElement.nextSibling);
            inserterElement.classList.add('inserting');
            textarea.focus();
        },
        showEditInput(messageWrapperElement, messageIndex) {
            const messageElement = messageWrapperElement.querySelector('.message');
            if (!messageElement) return;
            const contentDiv = messageElement.querySelector('.message-content');
            const bodyDiv = messageElement.querySelector('.message-body');
            const actionsDiv = messageWrapperElement.querySelector('.message-actions');
            const editBtn = actionsDiv?.querySelector('.edit-message-btn');
            if (!contentDiv || !bodyDiv || contentDiv.querySelector('.edit-textarea-wrapper')) return;
            this.removeEditAndInsertInputs();
            messageWrapperElement.classList.add('editing');
            const originalHTML = bodyDiv.innerHTML;
            messageWrapperElement.dataset.originalHtml = originalHTML;
            const tempDiv = document.createElement('div'); tempDiv.innerHTML = originalHTML.replace(/<br\s*\/?>/gi, '\n');
            const originalText = tempDiv.textContent || '';
            bodyDiv.innerHTML = `
                <div class="edit-textarea-wrapper">
                    <textarea class="edit-textarea">${originalText}</textarea>
                    <div class="input-buttons">
                        <button class="save-edit-btn">Save Edit</button>
                        <button class="cancel-edit-btn">Cancel</button>
                    </div>
                </div>`;
            if (editBtn) editBtn.disabled = true;
            const saveBtn = bodyDiv.querySelector('.save-edit-btn');
            const cancelBtn = bodyDiv.querySelector('.cancel-edit-btn');
            const textarea = bodyDiv.querySelector('.edit-textarea');
            this.adjustTextareaHeight(textarea);
            textarea.focus(); textarea.select();
            saveBtn.onclick = () => { handleSaveEdit(messageIndex, textarea.value.trim(), originalHTML, bodyDiv, messageWrapperElement); };
            cancelBtn.onclick = () => { this.cancelEdit(bodyDiv, originalHTML, messageWrapperElement); };
            textarea.addEventListener('keydown', e => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveBtn.click(); }
                else if (e.key === 'Escape') { cancelBtn.click(); }
            });
            textarea.addEventListener('input', () => this.adjustTextareaHeight(textarea));
        },
        cancelEdit(bodyDiv, originalHTML, messageWrapperElement) {
            bodyDiv.innerHTML = originalHTML;
            messageWrapperElement.classList.remove('editing');
            delete messageWrapperElement.dataset.originalHtml;
            const actionsDiv = messageWrapperElement.querySelector('.message-actions');
            const editBtn = actionsDiv?.querySelector('.edit-message-btn');
            if (editBtn) editBtn.disabled = false;
            this.processMessageContent(messageWrapperElement);
        },
        removeEditAndInsertInputs() {
            const existingInsertInput = document.querySelector('.new-message-input-area');
            if (existingInsertInput) {
                const associatedInserter = existingInsertInput.previousElementSibling;
                if (associatedInserter?.classList.contains('message-inserter')) {
                    associatedInserter.classList.remove('inserting');
                }
                existingInsertInput.remove();
            }
            const existingEditWrapper = document.querySelector('.edit-textarea-wrapper');
            if (existingEditWrapper) {
                const messageElement = existingEditWrapper.closest('.message.editing');
                if (messageElement) {
                    const bodyDiv = messageElement.querySelector('.message-body');
                    const originalHTML = messageElement.dataset.originalHtml || '';
                    if (bodyDiv) this.cancelEdit(bodyDiv, originalHTML, messageElement);
                    else { existingEditWrapper.remove(); messageElement.classList.remove('editing'); }
                } else existingEditWrapper.remove();
            }
        },
        showLoadingIndicator(element) { element.classList.add('loading-indicator'); console.log("Loading indicator shown"); },
        hideLoadingIndicator(element) { element.classList.remove('loading-indicator'); console.log("Loading indicator hidden"); }
    };
    initializeApp();
    async function initializeApp() {
        console.log("Initializing Ollama Chat Interface...");
        elements.topMessageInserter = ui.createMessageInserter(null, -1);
        elements.topMessageInserter.id = 'top-message-inserter';
        elements.chatMessages.appendChild(elements.topMessageInserter);
        loadResources();
        setupEventListeners();
        await api.fetchThreads();
        await Promise.all([
            api.fetchModels(),
            api.fetchFiles(),
        ]);
        await api.fetchConversationHistory();
        ui.updateSelectedFilesDisplay();
        ui.adjustTextareaHeight(elements.messageInput);
        console.log("Initialization complete.");
    }
    function loadResources() {
        loadScript('https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.7.0/highlight.min.js', () => {
            console.log("Highlight.js script loaded.");
            loadCSS('https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.7.0/styles/github-dark-dimmed.min.css');
            document.querySelectorAll('.message-body pre code, .thinking-content pre code').forEach(ui.highlightElement);
        });
    }
    function loadScript(url, callback) { const script = document.createElement('script'); script.src = url; script.onload = callback; script.onerror = () => console.error(`Failed to load script: ${url}`); document.head.appendChild(script); }
    function loadCSS(url) { const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = url; link.onload = () => console.log(`CSS loaded: ${url}`); link.onerror = () => console.error(`Failed to load CSS: ${url}`); document.head.appendChild(link); }
    function setupEventListeners() {
        elements.messageInput.addEventListener('keydown', handleMessageInputKeydown);
        elements.messageInput.addEventListener('input', () => ui.adjustTextareaHeight(elements.messageInput));
        elements.uploadFilesBtn.addEventListener('click', () => elements.fileInput.click());
        elements.fileInput.addEventListener('change', handleFileInputChange);
        setupDragDropListeners();
        elements.clearConversationBtn.addEventListener('click', handleClearConversation);
        elements.newThreadBtn.addEventListener('click', handleNewThread);
        elements.threadsContainer.addEventListener('click', handleThreadContainerClick);
        elements.settingsButton.addEventListener('click', handleSettingsButtonClick);
        elements.systemPromptInput.addEventListener('input', handleSystemPromptInput);
        elements.fileContextIntroInput.addEventListener('input', handleFileContextIntroInput);
        elements.appendFileContextSwitch.addEventListener('change', handleAppendContextSwitchChange);
        if (elements.settingsModal) { 
            elements.settingsModal.addEventListener('click', handleModalBackgroundClick);
        } else {
            console.error("Settings modal element not found!");
        }
        if (elements.renameThreadModal) { 
             elements.renameThreadModal.addEventListener('click', handleModalBackgroundClick); 
        } else {
             console.error("Rename thread modal element not found!"); 
        }
        elements.renameThreadModal.addEventListener('click', handleModalBackgroundClick);
        elements.confirmRenameBtn.addEventListener('click', handleConfirmRename);
        elements.cancelRenameBtn.addEventListener('click', () => ui.hideModal(elements.renameThreadModal));
        elements.filesContainer.addEventListener('click', handleFilesContainerClick);
        elements.selectedFilesDisplay.addEventListener('click', handleSelectedFilesDisplayClick);
        elements.chatMessages.addEventListener('click', handleChatMessagesClick);
        elements.sendButton.onclick = handleSendMessage;
    }
    function setupDragDropListeners() {
        const area = elements.chatContainer;
        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(ev => {
            area.addEventListener(ev, preventDefaults, false);
            document.body.addEventListener(ev, preventDefaults, false);
        });
        ['dragenter', 'dragover'].forEach(ev => {
            area.addEventListener(ev, () => area.classList.add('dragover'), false);
        });
        ['dragleave', 'drop'].forEach(ev => {
            area.addEventListener(ev, () => area.classList.remove('dragover'), false);
        });
        area.addEventListener('drop', handleDrop, false);
    }
    function preventDefaults(e) {
        e.preventDefault();
        e.stopPropagation();
    }
    function handleMessageInputKeydown(e) {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendMessage(); }
    }
    function handleFileInputChange() { if (elements.fileInput.files?.length > 0) uploadFiles(elements.fileInput.files); }
    function handleDrop(e) {
        elements.chatContainer.classList.remove('dragover');
        const files = e.dataTransfer?.files;
        if (files?.length > 0) {
            uploadFiles(files);
        } else {
            console.log("Drop event occurred but no files found in dataTransfer.");
        }
    }
    function handleFilesContainerClick(e) {
        const target = e.target;
        if (target.classList.contains('file-checkbox')) handleFileSelectionChange(target);
        else if (target.closest('.delete-btn')) {
            const filename = target.closest('.file-item')?.dataset.filename;
            if (filename) handleDeleteFile(filename);
        }
    }
    function handleSelectedFilesDisplayClick(e) {
        if (e.target.classList.contains('remove-file')) {
            const filename = e.target.closest('.selected-file-tag')?.dataset.filename;
            if (filename) {
                state.selectedFiles = state.selectedFiles.filter(f => f !== filename);
                const checkbox = elements.filesContainer.querySelector(`.file-checkbox[data-filename="${filename}"]`);
                if (checkbox) checkbox.checked = false;
                ui.updateSelectedFilesDisplay();
            }
        }
    }
    function handleFileSelectionChange(checkbox) {
        const filename = checkbox.dataset.filename;
        if (checkbox.checked) { if (!state.selectedFiles.includes(filename)) state.selectedFiles.push(filename); }
        else state.selectedFiles = state.selectedFiles.filter(f => f !== filename);
        ui.updateSelectedFilesDisplay();
    }
    async function handleDeleteFile(filename) {
        if (!confirm(`Permanently delete the file "${filename}"?`)) return;
        ui.showLoadingIndicator(elements.filesContainer);
        const result = await api.deleteFile(filename);
        ui.hideLoadingIndicator(elements.filesContainer);
        if (result.success) {
            state.selectedFiles = state.selectedFiles.filter(file => file !== filename);
            ui.updateSelectedFilesDisplay();
            await api.fetchFiles();
        } else {
            alert(`Failed to delete file: ${result.error || 'Unknown error'}`);
        }
    }
    async function handleClearConversation() {
        if (!confirm(`Delete all messages in thread "${getCurrentThreadName()}" and reset title?`)) return;
        const result = await api.clearConversation();
        if (result.success) {
            state.currentHistory = [];
            state.temporaryHistory = [];
            ui.renderMessages(state.temporaryHistory);
            await api.fetchThreads();
            console.log('Conversation cleared and title reset.');
        } else {
            alert('Failed to clear conversation.');
        }
    }
    async function handleNewThread() {
        if (state.isStreaming) { alert("Please wait for the current response to finish."); return; }
        if (hasUnsavedChanges() && !confirm("Discard unsaved changes and create new thread?")) return;
        const result = await api.createNewThread();
        if (result.success && result.data?.thread) {
            state.currentThreadId = result.data.thread.id;
            await api.fetchThreads();
            state.currentHistory = [];
            state.temporaryHistory = [];
            ui.renderMessages(state.temporaryHistory);
            ui.scrollToTop();
        } else {
            alert('Error creating new thread.');
        }
    }
    function handleThreadContainerClick(e) {
        const threadItem = e.target.closest('.thread-item');
        if (!threadItem) return;
        const threadId = threadItem.dataset.threadId;
        if (!threadId) return;
        if (e.target.closest('.rename-btn')) {
            const currentName = threadItem.querySelector('.thread-name')?.textContent || '';
            handleRenameThreadClick(threadId, currentName);
        } else if (e.target.closest('.delete-btn')) {
            const threadName = threadItem.querySelector('.thread-name')?.textContent || 'this thread';
            handleDeleteThreadClick(threadId, threadName);
        } else {
            handleActivateThread(threadId);
        }
    }
    async function handleActivateThread(threadId) {
        if (state.currentThreadId === threadId || state.isStreaming) return;
        if (hasUnsavedChanges() && !confirm("Discard unsaved changes and switch threads?")) return;
        console.log(`Activating thread: ${threadId}`);
        ui.showLoadingIndicator(elements.chatMessages);
        const result = await api.activateThread(threadId);
        ui.hideLoadingIndicator(elements.chatMessages);
        if (result.success && result.data) {
            state.currentThreadId = result.data.thread_id;
            document.querySelectorAll('.thread-item.active').forEach(el => el.classList.remove('active'));
            const newActiveItem = elements.threadsContainer.querySelector(`.thread-item[data-thread-id="${threadId}"]`);
            if (newActiveItem) newActiveItem.classList.add('active');
            state.currentHistory = result.data.history || [];
            state.temporaryHistory = JSON.parse(JSON.stringify(state.currentHistory));
            ui.renderMessages(state.temporaryHistory);
            ui.scrollToTop();
        } else {
            console.error('Error activating thread:', result.error);
            alert('Error switching thread.');
            await api.fetchThreads();
            await api.fetchConversationHistory();
        }
    }
    function handleRenameThreadClick(threadId, currentName) {
        state.renameThreadId = threadId;
        elements.threadNameInput.value = currentName;
        ui.showModal(elements.renameThreadModal);
        elements.threadNameInput.focus(); elements.threadNameInput.select();
    }
    async function handleConfirmRename() {
        const newName = elements.threadNameInput.value.trim();
        if (!newName) { alert("Thread name cannot be empty."); return; }
        if (state.renameThreadId) {
            const result = await api.renameThread(state.renameThreadId, newName);
            if (result.success) {
                ui.hideModal(elements.renameThreadModal);
                await api.fetchThreads();
            } else {
                alert(`Failed to rename thread: ${result.error || 'Unknown error'}`);
            }
        }
    }
    async function handleDeleteThreadClick(threadId, threadName) {
        if (state.isStreaming) { alert("Please wait for the current response to finish."); return; }
        if (!confirm(`Delete thread "${threadName}"? This cannot be undone.`)) return;
        if (state.currentThreadId === threadId && hasUnsavedChanges() && !confirm("Discard unsaved changes in this thread?")) return;
        const result = await api.deleteThread(threadId);
        if (result.success && result.data?.active_thread) {
            const newActiveThreadId = result.data.active_thread;
            await api.fetchThreads();
            if (state.currentThreadId === threadId) {
                 await handleActivateThread(newActiveThreadId);
            }
        } else {
            alert('Error deleting thread.');
            await api.fetchThreads();
        }
    }
    function handleSettingsButtonClick() {
        elements.systemPromptInput.value = state.systemPrompt;
        elements.fileContextIntroInput.value = state.fileContextIntro;
        elements.appendFileContextSwitch.checked = state.appendFileContext;
        elements.saveStatusDiv.textContent = ''; 
        ui.showModal(elements.settingsModal);
    }
    function debouncedSaveSetting(key, value, displayStatus = true) {
        if (state.saveTimeout) clearTimeout(state.saveTimeout);
        if (displayStatus) {
            elements.saveStatusDiv.textContent = 'Saving...';
            elements.saveStatusDiv.style.color = 'var(--text-secondary)';
        }
        state.saveTimeout = setTimeout(() => {
            localStorage.setItem(key, value);
            if (displayStatus) {
                elements.saveStatusDiv.textContent = 'Saved!';
                elements.saveStatusDiv.style.color = 'var(--success-color)';
                setTimeout(() => { elements.saveStatusDiv.textContent = ''; }, 2500);
            }
            console.log(`Saved setting: ${key}`);
        }, 1000); 
    }  
    function handleSystemPromptInput() {
        state.systemPrompt = elements.systemPromptInput.value;
        debouncedSaveSetting('systemPrompt', state.systemPrompt);
    }
    function handleFileContextIntroInput() {
        state.fileContextIntro = elements.fileContextIntroInput.value;
        debouncedSaveSetting('fileContextIntro', state.fileContextIntro);
    }
    function handleAppendContextSwitchChange() {
        state.appendFileContext = elements.appendFileContextSwitch.checked;
        localStorage.setItem('appendFileContext', JSON.stringify(state.appendFileContext));
        elements.saveStatusDiv.textContent = 'Saved!';
        elements.saveStatusDiv.style.color = 'var(--success-color)';
        setTimeout(() => { elements.saveStatusDiv.textContent = ''; }, 2500);
        console.log(`Saved setting: appendFileContext = ${state.appendFileContext}`);
    }
    function handleModalBackgroundClick(event) {
        if (event.target === elements.settingsModal) ui.hideModal(elements.settingsModal);
        if (event.target === elements.renameThreadModal) ui.hideModal(elements.renameThreadModal);
    }
    function handleChatMessagesClick(e) {
        const target = e.target;
        const messageWrapperElement = target.closest('.message-wrapper');
        const inserterElement = target.closest('.message-inserter');
        if (messageWrapperElement) {
            const messageIndex = parseInt(messageWrapperElement.dataset.messageIndex, 10);
            if (isNaN(messageIndex)) return;
            if (target.closest('.delete-message-btn')) handleDeleteMessageClick(messageIndex);
            else if (target.closest('.edit-message-btn')) handleEditMessageClick(messageIndex, messageWrapperElement);
            else if (target.closest('.resend-message-btn')) handleResendMessageClick(messageIndex);
        }
        else if (inserterElement) {
             if (state.isStreaming || document.querySelector('.edit-textarea-wrapper') || document.querySelector('.new-message-input-area')) return;
            const precedingMessageIndex = parseInt(inserterElement.dataset.precedingMessageIndex, 10);
            if (isNaN(precedingMessageIndex)) {
                 console.warn("Inserter has invalid preceding index:", inserterElement.dataset.precedingMessageIndex);
                 return;
            }
            if (target.classList.contains('insert-area')) {
                const role = target.classList.contains('left') ? 'assistant' : 'user';
                ui.showNewMessageInput(inserterElement, role, precedingMessageIndex);
            }
        }
    }
     function handleDeleteMessageClick(messageIndex) {
        if (state.isStreaming) { alert('Please wait until generation is complete.'); return; }
        if (confirm("Temporarily delete this message and subsequent messages?")) {
            state.temporaryHistory = state.temporaryHistory.slice(0, messageIndex);
            ui.renderMessages(state.temporaryHistory);
        }
    }
    function handleEditMessageClick(messageIndex, messageElement) {
        if (state.isStreaming) { alert('Please wait until generation is complete.'); return; }
        if (document.querySelector('.edit-textarea-wrapper')) ui.removeEditAndInsertInputs();
        ui.showEditInput(messageElement, messageIndex);
    }
    function handleSaveEdit(messageIndex, newContent, originalHTML, bodyDiv, messageWrapperElement) {
        if (newContent) {
            if (state.temporaryHistory[messageIndex]) {
                state.temporaryHistory[messageIndex].content = newContent;
                ui.renderMessages(state.temporaryHistory);
            } else {
                console.error("Message index out of bounds during save edit.");
                ui.cancelEdit(bodyDiv, originalHTML, messageWrapperElement);
            }
        } else {
            ui.cancelEdit(bodyDiv, originalHTML, messageWrapperElement);
        }
    }
    function handleSaveInsertedMessage(precedingMessageIndex, role, content, inputArea, inserterElement) {
        if (content) {
            const newIndex = precedingMessageIndex + 1;
            const newMessage = {
                id: `temp-${role}-${Date.now()}`, role: role, content: content,
                thinking: role === 'assistant' ? "" : null
            };
            state.temporaryHistory.splice(newIndex, 0, newMessage);
            state.temporaryHistory = state.temporaryHistory.slice(0, newIndex + 1);
            ui.renderMessages(state.temporaryHistory);
        } else {
            inputArea.remove();
            inserterElement.classList.remove('inserting');
        }
    }
async function handleResendMessageClick(messageIndex) {
        if (state.isStreaming) { alert('Please wait until generation is complete.'); return; }
        const messageToResend = state.temporaryHistory[messageIndex]; 
        if (!messageToResend || messageToResend.role !== 'user') {
            console.error("Cannot resend: Message not found or not a user message.");
            return;
        }
        console.log(`Resending from message index ${messageIndex}`);
        const historyForResend = state.temporaryHistory.slice(0, messageIndex + 1);
        const filesForResend = messageToResend.referencedFiles || [];
        state.temporaryHistory = [...historyForResend];
        ui.renderMessages(state.temporaryHistory);
        ui.scrollToBottom();
        const selectedModel = elements.modelDropdown.value;
        if (!selectedModel || selectedModel === "loading" || selectedModel === "") {
            alert("Please select a model.");
            return;
        }
        const payload = {
            model: selectedModel,
            messages: historyForResend, 
            references: filesForResend, 
            systemPrompt: state.systemPrompt,
            fileContextIntro: state.fileContextIntro,
            appendContext: state.appendFileContext,
        };
        await executeChatRequest(payload, true); 
    }
    async function handleSendMessage() {
        const userMessageContent = elements.messageInput.value.trim();
        const filesForThisMessage = [...state.selectedFiles];
        const messageContent = elements.messageInput.value.trim();
        const selectedModel = elements.modelDropdown.value;
        if (!messageContent) { alert("Please enter a message."); return; }
        if (!selectedModel || selectedModel === "loading" || selectedModel === "") { alert("Please select a model."); return; }
        if (state.isStreaming) { console.warn("Already streaming."); return; }
        const newUserMessage = {
            role: 'user',
            content: userMessageContent,
            referencedFiles: filesForThisMessage, 
            id: `temp-user-${Date.now()}`
        };
        state.temporaryHistory.push(newUserMessage);
        ui.renderMessages(state.temporaryHistory);
        elements.messageInput.value = '';
        ui.adjustTextareaHeight(elements.messageInput);
        ui.scrollToBottom();
        const payload = {
            model: selectedModel,
            messages: [...state.temporaryHistory], 
            references: filesForThisMessage, 
            systemPrompt: state.systemPrompt,
            fileContextIntro: state.fileContextIntro,
            appendContext: state.appendFileContext,
        };
        await executeChatRequest(payload, false);
    }
    async function executeChatRequest(payload, isResend = false) {
        if (state.isStreaming) { console.warn("executeChatRequest called while already streaming."); return; }
        state.isStreaming = true;
        ui.toggleStopButton(true);
        elements.messageInput.disabled = true;
        const typingIndicator = ui.createKittIndicator();
        if (!elements.chatMessages.contains(typingIndicator)) {
            elements.chatMessages.appendChild(typingIndicator);
        }
        ui.scrollToBottom();
        state.abortController = new AbortController();
        let wasAborted = false;
        try {
            console.log(`Executing chat request. Resend: ${isResend}. History length: ${payload.messages.length}`);
            console.log("Payload Settings:", { intro: payload.fileContextIntro, append: payload.appendContext }); 
            const response = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
                body: JSON.stringify(payload), 
                credentials: 'include',
                signal: state.abortController.signal
            });
            if (!response.ok) {
                const errorText = await response.text();
                let errorJson = {}; try { errorJson = JSON.parse(errorText); } catch(e) {}
                throw new Error(`Network response was not ok: ${response.status} ${response.statusText}. ${errorJson.error || errorText}`);
            }
            if (!response.body) throw new Error('Response body is null');
            await processChatStream(response.body, typingIndicator);
            console.log("Stream finished successfully. Fetching definitive history.");
            await api.fetchConversationHistory();
            console.log("Re-rendering UI after history sync.");
            ui.renderMessages(state.temporaryHistory);
            await generateThreadTitleIfNeeded();
        } catch (error) {
            console.error('Error during chat execution:', error);
            ui.hideTypingIndicator(typingIndicator);
            if (error.name === 'AbortError') {
                console.log('Request aborted by user. Partial response preserved in temporary history.');
                wasAborted = true;
            } else {
                 const errorId = `temp-error-${Date.now()}`;
                 const errorMessage = { role: "assistant", content: `Error: ${error.message || 'Could not communicate with the backend.'}`, id: errorId, thinking: null };
                 state.temporaryHistory.push(errorMessage);
                 ui.renderMessages(state.temporaryHistory);
                 ui.scrollToBottom();
            }
        } finally {
            console.log(`Chat execution finished (wasAborted: ${wasAborted}). Cleaning up state.`);
            state.isStreaming = false;
            state.abortController = null;
            ui.toggleStopButton(false);
            elements.messageInput.disabled = false;
            ui.hideTypingIndicator(typingIndicator);
            elements.chatMessages.querySelectorAll('.message-actions button').forEach(button => {
                button.disabled = false;
            });
            console.log("Action buttons re-enabled in finally block.");
            if (!isResend) {
                elements.messageInput.focus();
            }
        }
    }
    function handleStopGeneration() {
        if (state.abortController) {
            console.log("Aborting chat stream request...");
            state.abortController.abort();
        } else {
            console.warn("Stop called but no AbortController found.");
        }
    }
    async function processChatStream(streamBody, typingIndicator) {
        const reader = streamBody.getReader();
        const decoder = new TextDecoder();
        let accumulatedContent = '';
        let accumulatedThinking = '';
        let hasThinking = false;
        let botMessageIndex = -1;
        let serverResponseReceived = false;
        let tempBotMessage = null;
        let botMessageWrapperElement = null;
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    break;
                }
                const chunk = decoder.decode(value, { stream: true });
                const eventLines = chunk.split('\n\n');
                for (const line of eventLines) {
                    if (line.startsWith('data: ')) {
                        try {
                            const data = JSON.parse(line.substring(6));
                            if (data.content) {
                                if (!serverResponseReceived) {
                                     ui.hideTypingIndicator(typingIndicator);
                                     serverResponseReceived = true;
                                     tempBotMessage = { role: "assistant", content: "", thinking: null, id: `temp-bot-${Date.now()}` };
                                     state.temporaryHistory.push(tempBotMessage);
                                     botMessageIndex = state.temporaryHistory.length - 1;
                                     ui.renderMessages(state.temporaryHistory);
                                     botMessageWrapperElement = elements.chatMessages.querySelector(`.message-wrapper[data-message-index="${botMessageIndex}"]`);
                                }
                                accumulatedContent += data.content;
                                if (tempBotMessage) {
                                    tempBotMessage.content = accumulatedContent;
                                    tempBotMessage.thinking = hasThinking ? accumulatedThinking : null;
                                }
                                if (botMessageWrapperElement) {
                                    ui.updateMessageElementDOM(botMessageWrapperElement, accumulatedContent, hasThinking ? accumulatedThinking : null);
                                } else {
                                    console.warn("Bot message wrapper element not found for streaming update, re-rendering.");
                                    ui.renderMessages(state.temporaryHistory);
                                    botMessageWrapperElement = elements.chatMessages.querySelector(`.message-wrapper[data-message-index="${botMessageIndex}"]`);
                                }
                                ui.scrollToBottom();
                            }
                            if (data.done) {
                                return;
                            }
                        } catch (e) { console.error('Error parsing SSE data:', e, "Raw Line:", line); }
                    }
                }
            }
        } catch (streamError) {
             console.error("Error reading from stream:", streamError);
            throw streamError;
        } finally {
            reader.releaseLock();
            console.log("Stream reader released.");
            ui.hideTypingIndicator(typingIndicator);
        }
    }
    async function uploadFiles(files) {
        if (state.uploadInProgress) { alert("Upload already in progress."); return; }
        if (!files || files.length === 0) return;
        state.uploadInProgress = true;
        ui.updateUploadStatus(`Uploading ${files.length} file(s)...`, 'uploading');
        let successCount = 0, errorCount = 0;
        const successfullyUploadedFilenames = []; 
        const uploadPromises = Array.from(files).map(file => {
            const formData = new FormData(); formData.append('file', file);
            return fetch('/api/upload', { method: 'POST', body: formData, credentials: 'include' })
                .then(response => response.json())
                .then(data => {
                    if (data.success) {
                        successCount++;
                        successfullyUploadedFilenames.push(data.filename); 
                    } else {
                        errorCount++;
                    }
                })
                .catch(() => errorCount++);
        });
        await Promise.all(uploadPromises);
        state.uploadInProgress = false;
        ui.updateUploadStatusFinal(successCount, errorCount, files.length);
        elements.fileInput.value = ''; 
        await api.fetchFiles();
        if (successfullyUploadedFilenames.length > 0) {
            successfullyUploadedFilenames.forEach(filename => {
                const checkbox = elements.filesContainer.querySelector(`.file-checkbox[data-filename="${filename}"]`);
                if (checkbox && !checkbox.checked) {
                    checkbox.checked = true;
                    if (!state.selectedFiles.includes(filename)) {
                        state.selectedFiles.push(filename);
                    }
                }
            });
            ui.updateSelectedFilesDisplay(); 
        }
    }
    async function generateThreadTitleIfNeeded() {
        const messagesForTitle = state.temporaryHistory;
        const currentThreadName = getCurrentThreadName();
        const shouldGenerate = messagesForTitle.length >= 2 && messagesForTitle.length <= 6 &&
                               (!currentThreadName || currentThreadName.toLowerCase() === 'new thread');
        if (!shouldGenerate) return;
        const selectedModel = elements.modelDropdown.value;
        if (!selectedModel || selectedModel === "loading" || selectedModel === "") return;
        console.log(`Attempting title generation for thread ${state.currentThreadId}...`);
        const conversation = {
            messages: messagesForTitle.map(msg => ({ role: msg.role, content: msg.content })),
            threadId: state.currentThreadId, model: selectedModel
        };
        const result = await api.generateTitle(conversation);
        if (result.success && result.data?.title) {
            console.log(`Generated title: "${result.data.title}". Renaming.`);
            const renameResult = await api.renameThread(state.currentThreadId, result.data.title);
            if (renameResult.success) await api.fetchThreads();
            else console.error("Failed to rename thread with generated title:", renameResult.error);
        } else if (!result.success) console.error('Error generating title:', result.error);
        else console.log("Title generation returned no title.");
    }
    function getCurrentThreadName() {
        const activeThreadElement = elements.threadsContainer.querySelector('.thread-item.active .thread-name');
        return activeThreadElement?.textContent || null;
    }
    function hasUnsavedChanges() {
        if (state.temporaryHistory.length !== state.currentHistory.length) return true;
        try {
            return JSON.stringify(state.temporaryHistory) !== JSON.stringify(state.currentHistory);
        } catch (e) {
            console.error("Error comparing histories:", e);
            return true; 
        }
    }
});