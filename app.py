from flask import Flask, request, jsonify, render_template, redirect, url_for, session, stream_with_context
import os
import requests
import re
import json
import argparse
from werkzeug.utils import secure_filename
import uuid
from datetime import timedelta, datetime
import traceback
app = Flask(__name__, static_folder='static')
app.secret_key = os.environ.get('FLASK_SECRET_KEY', 'your-default-secret-key-123')
app.config.update(
    PERMANENT_SESSION_LIFETIME=timedelta(days=7),
    SESSION_COOKIE_SECURE=False,
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE='Lax',
    SESSION_COOKIE_NAME='ollama_chat_session'
)
UPLOAD_FOLDER = 'uploads'
DATA_FOLDER = 'data'
ALLOWED_EXTENSIONS = {'txt', 'py', 'js', 'css', 'html', 'sh', 'md', 'json', 'csv', 'pdf', 'png', 'jpg', 'jpeg', 'gif'}
app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER
app.config['DATA_FOLDER'] = DATA_FOLDER
conversations = {}
threads = {}
DEFAULT_THREAD_NAME = "New Thread"
DEFAULT_FILE_CONTEXT_INTRO = "I'm going to reference some files. Please consider these in your response:" # Define default here too
def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS
def save_data():
    data_path = os.path.join(app.config['DATA_FOLDER'], 'conversations.json')
    threads_path = os.path.join(app.config['DATA_FOLDER'], 'threads.json')
    try:
        os.makedirs(app.config['DATA_FOLDER'], exist_ok=True)
        conv_copy = conversations.copy()
        threads_copy = threads.copy()
        with open(data_path, 'w') as f:
            json.dump(conv_copy, f, indent=2)
        with open(threads_path, 'w') as f:
            json.dump(threads_copy, f, indent=2)
        return True
    except Exception as e:
        print(f"Error saving data: {str(e)}")
        traceback.print_exc()
        return False
def load_data():
    global conversations, threads
    data_path = os.path.join(app.config['DATA_FOLDER'], 'conversations.json')
    threads_path = os.path.join(app.config['DATA_FOLDER'], 'threads.json')
    try:
        if os.path.exists(data_path):
            with open(data_path, 'r') as f:
                conversations = json.load(f)
                print(f"Loaded {len(conversations)} sessions from conversations.json")
        else: conversations = {}; print("conversations.json not found.")
        if os.path.exists(threads_path):
            with open(threads_path, 'r') as f:
                threads = json.load(f)
                print(f"Loaded {len(threads)} sessions from threads.json")
        else: threads = {}; print("threads.json not found.")
        return True
    except json.JSONDecodeError as e:
        print(f"Error decoding JSON data: {str(e)}. Starting empty.")
        conversations = {}; threads = {}
        return False
    except Exception as e:
        print(f"Error loading data: {str(e)}"); traceback.print_exc()
        conversations = {}; threads = {}
        return False
def get_session_data():
    if 'session_id' not in session:
        session['session_id'] = str(uuid.uuid4())
        print(f"New session created: {session['session_id']}")
    session_id = session['session_id']
    threads.setdefault(session_id, [])
    conversations.setdefault(session_id, {})
    active_thread_id = session.get('active_thread')
    valid_active_thread_exists = active_thread_id and active_thread_id in conversations[session_id]
    if not valid_active_thread_exists:
        session_threads = threads[session_id]
        if session_threads:
            session_threads.sort(key=lambda x: x.get('updated_at', ''), reverse=True)
            potential_active_id = session_threads[0]['id']
            if potential_active_id in conversations[session_id]:
                 session['active_thread'] = potential_active_id
                 print(f"Set active thread to most recent: {potential_active_id} for session {session_id}")
            else:
                 valid_active_thread_exists = False
        else:
             valid_active_thread_exists = False
        if not valid_active_thread_exists:
            print(f"No valid active thread found for session {session_id}. Creating default.")
            default_thread_id = str(uuid.uuid4())
            now = datetime.now().isoformat()
            default_thread = { 'id': default_thread_id, 'name': DEFAULT_THREAD_NAME, 'created_at': now, 'updated_at': now }
            threads[session_id].insert(0, default_thread)
            conversations[session_id][default_thread_id] = []
            session['active_thread'] = default_thread_id
            print(f"Created and activated default thread {default_thread_id} for session {session_id}")
            save_data()
    return session_id, session.get('active_thread')
def get_uploaded_files():
    upload_folder = app.config['UPLOAD_FOLDER']
    if not os.path.exists(upload_folder): os.makedirs(upload_folder); return []
    try:
        files = [f for f in os.listdir(upload_folder) if os.path.isfile(os.path.join(upload_folder, f)) and not f.startswith('.')]
        return sorted(files)
    except Exception as e: print(f"Error listing uploaded files: {e}"); return []
@app.before_request
def ensure_session():
    session.permanent = True
    get_session_data()
@app.route('/')
def index():
    session_id, active_thread_id = get_session_data()
    print(f"Serving index page for session {session_id}, active thread {active_thread_id}")
    return render_template('index.html')
@app.route('/api/models', methods=['GET'])
def get_models():
    try:
        ollama_url = os.environ.get('OLLAMA_API_URL', 'http://localhost:11434')
        response = requests.get(f'{ollama_url}/api/tags', timeout=10)
        response.raise_for_status()
        models_data = response.json()
        models = models_data.get('models', [])
        models.sort(key=lambda x: x.get('name', ''))
        return jsonify(models)
    except requests.exceptions.RequestException as e:
        print(f"Error fetching models from Ollama: {e}")
        return jsonify({"error": f"Could not connect to Ollama API: {e}"}), 503
    except Exception as e:
        print(f"Unexpected error fetching models: {e}"); traceback.print_exc()
        return jsonify({"error": "An unexpected error occurred while fetching models"}), 500
@app.route('/api/conversation/history', methods=['GET'])
def get_conversation_history():
    session_id, thread_id = get_session_data()
    history = conversations.get(session_id, {}).get(thread_id, [])
    print(f"Returning history for thread {thread_id} (Session: {session_id}), Length: {len(history)}")
    return jsonify({"success": True, "history": history, "thread_id": thread_id}), 200
@app.route('/api/threads', methods=['GET'])
def get_threads_list():
    session_id, active_thread_id = get_session_data()
    session_threads = threads.get(session_id, [])
    session_threads.sort(key=lambda x: x.get('updated_at', ''), reverse=True)
    return jsonify({"success": True, "threads": session_threads, "active_thread": active_thread_id}), 200
@app.route('/api/threads/new', methods=['POST'])
def create_thread():
    session_id, _ = get_session_data()
    thread_id = str(uuid.uuid4())
    now = datetime.now().isoformat()
    new_thread = { 'id': thread_id, 'name': DEFAULT_THREAD_NAME, 'created_at': now, 'updated_at': now }
    threads.setdefault(session_id, []).insert(0, new_thread)
    conversations.setdefault(session_id, {})[thread_id] = []
    session['active_thread'] = thread_id
    print(f"Created new thread {thread_id} for session {session_id}")
    if save_data():
        return jsonify({"success": True, "thread": new_thread}), 201
    else:
        return jsonify({"error": "Failed to save new thread data"}), 500
@app.route('/api/threads/<thread_id>/activate', methods=['POST'])
def activate_thread(thread_id):
    session_id, current_active_thread = get_session_data()
    session_threads = threads.get(session_id, [])
    thread_exists = any(t['id'] == thread_id for t in session_threads)
    conversation_exists = thread_id in conversations.get(session_id, {})
    if not thread_exists or not conversation_exists:
        print(f"Attempt to activate non-existent or invalid thread {thread_id} in session {session_id}")
        return jsonify({"error": "Thread not found or invalid"}), 404
    if thread_id == current_active_thread:
        print(f"Thread {thread_id} is already active.")
        history = conversations[session_id][thread_id]
        return jsonify({"success": True, "thread_id": thread_id, "history": history}), 200
    session['active_thread'] = thread_id
    print(f"Activated thread {thread_id} for session {session_id}")
    history = conversations[session_id][thread_id]
    return jsonify({"success": True, "thread_id": thread_id, "history": history}), 200
@app.route('/api/threads/<thread_id>/rename', methods=['POST'])
def rename_thread(thread_id):
    session_id, _ = get_session_data()
    data = request.json
    new_name = data.get('name', '').strip()
    if not new_name: return jsonify({"error": "New name cannot be empty"}), 400
    session_threads = threads.get(session_id, [])
    thread_found = False
    for thread in session_threads:
        if thread['id'] == thread_id:
            thread['name'] = new_name
            thread['updated_at'] = datetime.now().isoformat()
            thread_found = True
            print(f"Renamed thread {thread_id} to '{new_name}' for session {session_id}")
            break
    if not thread_found: return jsonify({"error": "Thread not found"}), 404
    if save_data(): return jsonify({"success": True, "thread_id": thread_id, "new_name": new_name}), 200
    else: return jsonify({"error": "Failed to save renamed thread data"}), 500
@app.route('/api/threads/<thread_id>/delete', methods=['DELETE'])
def delete_thread(thread_id):
    session_id, active_thread_id = get_session_data()
    session_threads = threads.get(session_id, [])
    thread_index = next((i for i, t in enumerate(session_threads) if t['id'] == thread_id), -1)
    if thread_index == -1: return jsonify({"error": "Thread not found"}), 404
    deleted_thread_name = threads[session_id].pop(thread_index)['name']
    print(f"Deleted thread {thread_id} ('{deleted_thread_name}') from session {session_id}")
    if thread_id in conversations.get(session_id, {}):
        del conversations[session_id][thread_id]
        print(f"Deleted conversation data for thread {thread_id}")
    new_active_thread_id = active_thread_id
    if active_thread_id == thread_id:
        _, new_active_thread_id = get_session_data()
        print(f"Deleted thread was active. New active thread is {new_active_thread_id}")
    if save_data():
        return jsonify({"success": True, "active_thread": new_active_thread_id}), 200
    else:
        return jsonify({"error": "Failed to save data after deleting thread"}), 500
@app.route('/api/chat', methods=['POST'])
def chat():
    session_id, thread_id = get_session_data()
    try:
        data = request.json
        model = data.get('model')
        frontend_messages = data.get('messages', [])
        references = data.get('references', [])
        system_prompt = data.get('systemPrompt', 'You are a helpful assistant.')
        file_context_intro = data.get('fileContextIntro', DEFAULT_FILE_CONTEXT_INTRO)
        append_context = data.get('appendContext', False) # Default to False (prepend)
        if not model: return jsonify({"error": "Model is required"}), 400
        if not frontend_messages: return jsonify({"error": "Messages are required"}), 400
        context_prefix = ""
        if references:
            context_parts = []
            for ref in references:
                safe_ref = secure_filename(ref)
                if safe_ref != ref: print(f"Warning: Skipped unsafe filename: {ref}"); continue
                file_path = os.path.join(app.config['UPLOAD_FOLDER'], safe_ref)
                if os.path.exists(file_path) and allowed_file(safe_ref):
                    try:
                        with open(file_path, 'r', encoding='utf-8', errors='ignore') as file:
                            content = file.read()
                            # Format file content without the intro sentence here
                            context_parts.append(f"--- File: {safe_ref} ---\n{content}\n--- End File: {safe_ref} ---")
                    except Exception as e: print(f"Error reading ref {safe_ref}: {e}")
                else: print(f"Ref not found/allowed: {ref}")

            if context_parts:
                # Construct the full prefix using the user's intro sentence
                context_prefix = f"{file_context_intro}\n" + "\n".join(context_parts)
        ollama_messages = []
        persistent_messages = []
        if system_prompt: ollama_messages.append({"role": "system", "content": system_prompt})
        for i, msg in enumerate(frontend_messages):
            if not isinstance(msg, dict) or 'role' not in msg or 'content' not in msg: continue
            role = msg['role']
            if role not in ['user', 'assistant']: continue

            original_content = msg['content'] # Keep original content for saving
            ollama_content = original_content # Start with original content for Ollama message

            # --- Apply File Context based on settings ---
            is_last_user_message = (i == len(frontend_messages) - 1 and role == 'user')
            if is_last_user_message and context_prefix:
                if append_context:
                    # Append context *after* user message
                    ollama_content = f"{original_content}\n\n{context_prefix}"
                    print(f"Appending file context for message {i}")
                else:
                    # Prepend context *before* user message (default)
                    ollama_content = f"{context_prefix}\n\n{original_content}"
                    print(f"Prepending file context for message {i}")
            # --- End Apply File Context ---

            ollama_messages.append({"role": role, "content": ollama_content})

            # --- Prepare message for saving (use original content) ---
            persistent_msg = {
                "id": msg.get('id') if msg.get('id') and not str(msg.get('id')).startswith('temp-') else str(uuid.uuid4()),
                "role": role,
                "content": original_content, # Save the user's text without the prepended/appended context
                "referencedFiles": msg.get('referencedFiles', []) if role == 'user' else None # Save referenced files with user message
            }
            # Only include thinking if it exists and is not None
            if 'thinking' in msg and msg['thinking'] is not None:
                persistent_msg['thinking'] = msg['thinking']

            # Remove referencedFiles key if it's None (for assistant messages)
            if persistent_msg.get("referencedFiles") is None:
                del persistent_msg["referencedFiles"]

            persistent_messages.append(persistent_msg)
            # --- End Prepare message for saving ---


        # Save the history *before* sending to Ollama, using the persistent_messages
        conversations[session_id][thread_id] = persistent_messages
        print(f"Saved frontend history (len {len(persistent_messages)}) for thread {thread_id} before Ollama call")
        for thread in threads.get(session_id, []):
            if thread['id'] == thread_id: thread['updated_at'] = datetime.now().isoformat(); break
        if not save_data(): return jsonify({"error": "Failed to save state before chat"}), 500

        # --- Send to Ollama ---
        ollama_url = os.environ.get('OLLAMA_API_URL', 'http://localhost:11434')
        payload = { "model": model, "messages": ollama_messages, "stream": True } # Use the modified ollama_messages
        print(f"Sending request to Ollama ({model})...")
        try:
            response = requests.post(f'{ollama_url}/api/chat', json=payload, stream=True, timeout=5000)
            response.raise_for_status()
        except requests.exceptions.RequestException as e:
             print(f"Error calling Ollama /api/chat: {e}")
             return jsonify({"error": f"Failed to connect to Ollama chat API: {e}"}), 503
        def generate():
            assistant_response_content = ""
            assistant_response_thinking = ""
            has_thinking_tag = False
            error_occurred = False
            assistant_message_id = str(uuid.uuid4())
            try:
                for line in response.iter_lines():
                    if line:
                        try:
                            chunk = json.loads(line.decode('utf-8'))
                            if chunk.get('error'):
                                print(f"Ollama error: {chunk['error']}")
                                yield f"data: {json.dumps({'error': chunk['error']})}\n\n"; error_occurred = True; break
                            if 'message' in chunk and 'content' in chunk['message']:
                                content_part = chunk['message']['content']
                                assistant_response_content += content_part
                                yield f"data: {json.dumps({'content': content_part})}\n\n"
                            if chunk.get('done', False) and chunk.get('total_duration'):
                                print("Ollama stream finished."); break
                        except json.JSONDecodeError: print(f"Warning: JSON decode failed: {line}")
                        except Exception as e: print(f"Error processing chunk: {e}"); traceback.print_exc(); yield f"data: {json.dumps({'error': 'Stream processing error'})}\n\n"; error_occurred = True; break
                if not error_occurred and assistant_response_content:
                    final_content = assistant_response_content
                    if '</think>' in assistant_response_content:
                        parts = assistant_response_content.split('</think>', 1)
                        assistant_response_thinking = parts[0].replace('<think>', '').strip()
                        final_content = parts[1].strip(); has_thinking_tag = True
                    assistant_message = { "id": assistant_message_id, "role": "assistant", "content": final_content, "thinking": assistant_response_thinking if has_thinking_tag else None }
                    conversations[session_id][thread_id].append(assistant_message)
                    print(f"Appended assistant msg {assistant_message_id} to thread {thread_id}")
                    for thread in threads.get(session_id, []):
                        if thread['id'] == thread_id: thread['updated_at'] = datetime.now().isoformat(); break
                    save_data()
                yield f"data: {json.dumps({'done': True})}\n\n"
            except Exception as e:
                print(f"Error during stream generation: {e}"); traceback.print_exc()
                try: yield f"data: {json.dumps({'error': f'Streaming error: {e}', 'done': True})}\n\n"
                except Exception as yield_e: print(f"Error sending final error: {yield_e}")
            finally: response.close(); print("Ollama response closed.")
        return app.response_class(stream_with_context(generate()), mimetype='text/event-stream')
    except Exception as e:
        print(f"--- Error in /api/chat ---"); traceback.print_exc(); print(f"-------------------------")
        return jsonify({"error": f"Unexpected server error: {str(e)}"}), 500
@app.route('/api/generate-title', methods=['POST'])
def generate_title():
    session_id, thread_id = get_session_data()
    try:
        data = request.json
        messages = data.get('messages', [])
        selected_model = data.get('model')
        if not messages:
            return jsonify({"success": False, "error": "No messages provided"}), 400
        if not selected_model:
            return jsonify({"success": False, "error": "Model not specified"}), 400
        max_snippet = 6
        snippet_messages = messages[:max_snippet//2] + messages[-max_snippet//2:] if len(messages) > max_snippet else messages
        snippet = "Snippet:\n"
        for msg in snippet_messages:
            role = "User" if msg.get("role") == "user" else "Assistant"
            content = msg.get('content', '')[:150] + ('...' if len(msg.get('content', '')) > 150 else '')
            snippet += f"{role}: {content}\n"
        system_prompt = "Generate a concise, specific title (max 8 words) for the conversation snippet. Focus on the core topic. Avoid generic terms. Output ONLY the title."
        print(f"--- Generating Title for {thread_id} ({selected_model}) ---")
        ollama_url = os.environ.get('OLLAMA_API_URL', 'http://localhost:11434')
        response = requests.post(
            f'{ollama_url}/api/generate',
            json={
                "model": selected_model,
                "system": system_prompt,
                "prompt": snippet,
                "stream": False,
            },
        )
        response.raise_for_status() 
        response_data = response.json()
        full_title_response = response_data.get("response", "").strip()
        if not full_title_response:
            print("Ollama returned empty title response.")
            return jsonify({"success": True, "title": "Chat Summary"})
        actual_title = full_title_response
        if '</think>' in full_title_response:
            parts = full_title_response.split('</think>', 1)
            if len(parts) > 1:
                actual_title = parts[1].strip()
                print(f"Stripped thinking part from title. Raw: '{full_title_response}', Using: '{actual_title}'")
            else:
                actual_title = "" 
                print(f"Warning: Found '</think>' but couldn't properly extract title content: '{full_title_response}'")
        if not actual_title:
             print("Title content became empty after stripping think tags or was originally empty.")
             return jsonify({"success": True, "title": "Chat Summary"}) 
        title = re.sub(r'<.*?>', '', actual_title)
        title = re.sub(r'^\W+|\W+$', '', title)
        title = re.sub(r'\s+', ' ', title).strip()
        if title:
            title = title[0].upper() + title[1:]
            print(f"Generated title: '{title}'")
            return jsonify({"success": True, "title": title})
        else:
            print("Title became empty after cleaning. Using fallback.")
            return jsonify({"success": True, "title": "Chat Summary"})
    except requests.exceptions.RequestException as e:
        print(f"Ollama title generation request error: {e}")
        return jsonify({"success": False, "error": f"Ollama connection error during title generation: {e}"}), 503
    except Exception as e:
        print(f"--- Error in generate_title ---")
        traceback.print_exc()
        return jsonify({"success": False, "error": "Internal server error during title generation"}), 500
@app.route('/api/upload', methods=['POST'])
def api_upload_file():
    session_id, _ = get_session_data()
    if 'file' not in request.files: return jsonify({"error": "No file part"}), 400
    file = request.files['file']
    if file.filename == '': return jsonify({"error": "No selected file"}), 400
    if file and allowed_file(file.filename):
        filename = secure_filename(file.filename)
        upload_folder = app.config['UPLOAD_FOLDER']; os.makedirs(upload_folder, exist_ok=True)
        save_path = os.path.join(upload_folder, filename)
        try: file.save(save_path); print(f"Uploaded: {filename} (Session: {session_id})"); return jsonify({"success": True, "filename": filename}), 200
        except Exception as e: print(f"Error saving {filename}: {e}"); traceback.print_exc(); return jsonify({"error": f"Save error: {e}"}), 500
    else: print(f"File type not allowed: {file.filename}"); return jsonify({"error": "File type not allowed"}), 400
@app.route('/api/files', methods=['GET'])
def get_files_list(): return jsonify(get_uploaded_files())
@app.route('/api/files/<path:filename>', methods=['DELETE'])
def delete_file_api(filename):
    session_id, _ = get_session_data()
    safe_filename = secure_filename(filename)
    if not safe_filename or safe_filename != filename: return jsonify({"error": "Invalid filename"}), 400
    file_path = os.path.join(app.config['UPLOAD_FOLDER'], safe_filename)
    if not os.path.exists(file_path): return jsonify({"error": "File not found"}), 404
    if not os.path.isfile(file_path): return jsonify({"error": "Invalid path"}), 400
    try: os.remove(file_path); print(f"Deleted file: {safe_filename} (Session: {session_id})"); return jsonify({"success": True}), 200
    except Exception as e: print(f"Error deleting {safe_filename}: {e}"); traceback.print_exc(); return jsonify({"error": f"Delete error: {e}"}), 500
@app.route('/api/conversation/clear', methods=['POST'])
def clear_conversation():
    session_id, thread_id = get_session_data()
    thread_cleared = False
    title_reset = False
    if thread_id in conversations.get(session_id, {}):
        conversations[session_id][thread_id] = []
        print(f"Cleared messages for thread {thread_id} (Session: {session_id})")
        thread_cleared = True
    session_threads = threads.get(session_id, [])
    for thread in session_threads:
        if thread['id'] == thread_id:
            if thread['name'] != DEFAULT_THREAD_NAME:
                 thread['name'] = DEFAULT_THREAD_NAME
                 thread['updated_at'] = datetime.now().isoformat()
                 title_reset = True
                 print(f"Reset title for thread {thread_id}")
            break
    if thread_cleared or title_reset:
        if save_data(): return jsonify({"success": True}), 200
        else: return jsonify({"error": "Failed to save cleared conversation/title"}), 500
    else:
        print(f"Attempted to clear non-existent or already cleared/default thread {thread_id}")
        return jsonify({"success": True}), 200
if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Run Ollama Chat interface')
    parser.add_argument('--host', default='127.0.0.1', help='Host (default: 127.0.0.1)')
    parser.add_argument('--port', type=int, default=5000, help='Port (default: 5000)')
    parser.add_argument('--debug', action='store_true', help='Enable Flask debug mode')
    parser.add_argument('--reload', action='store_true', help='Enable auto-reloader (implies debug)')
    args = parser.parse_args()
    load_data()
    use_reloader = args.reload or args.debug
    print(f"Starting Flask server on {args.host}:{args.port} | Debug: {args.debug} | Reload: {use_reloader}")
    print(f"Uploads: {os.path.abspath(app.config['UPLOAD_FOLDER'])} | Data: {os.path.abspath(app.config['DATA_FOLDER'])}")
    print(f"Ollama URL: {os.environ.get('OLLAMA_API_URL', 'http://localhost:11434')}")
    app.run(host=args.host, port=args.port, debug=args.debug, use_reloader=use_reloader)
