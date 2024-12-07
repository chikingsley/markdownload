// default variables
var selectedText = null;
var imageList = null;
var mdClipsFolder = '';
var originalMarkdown = ''; // Add for Claude integration
var cleanedMarkdown = ''; // Add for Claude integration
const cleanedContentCache = new Map();

const darkMode = window.matchMedia('(prefers-color-scheme: dark)').matches;
// set up event handlers
const cm = CodeMirror.fromTextArea(document.getElementById("md"), {
    theme: darkMode ? "xq-dark" : "xq-light",
    mode: "markdown",
    lineWrapping: true
});
cm.on("cursorActivity", (cm) => {
    const somethingSelected = cm.somethingSelected();
    var a = document.getElementById("downloadSelection");

    if (somethingSelected) {
        if(a.style.display != "block") a.style.display = "block";
    }
    else {
        if(a.style.display != "none") a.style.display = "none";
    }
});
document.getElementById("download").addEventListener("click", download);
document.getElementById("downloadSelection").addEventListener("click", downloadSelection);

const defaultOptions = {
    includeTemplate: false,
    clipSelection: true,
    downloadImages: false,
    mistralApiKey: '' // Add Mistral API key to options
}

const checkInitialSettings = options => {
    if (options.includeTemplate)
        document.querySelector("#includeTemplate").classList.add("checked");

    if (options.downloadImages)
        document.querySelector("#downloadImages").classList.add("checked");

    if (options.clipSelection)
        document.querySelector("#selected").classList.add("checked");
    else
        document.querySelector("#document").classList.add("checked");
}

const toggleClipSelection = options => {
    options.clipSelection = !options.clipSelection;
    document.querySelector("#selected").classList.toggle("checked");
    document.querySelector("#document").classList.toggle("checked");
    browser.storage.sync.set(options).then(() => clipSite()).catch((error) => {
        console.error(error);
    });
}

const toggleIncludeTemplate = options => {
    options.includeTemplate = !options.includeTemplate;
    document.querySelector("#includeTemplate").classList.toggle("checked");
    browser.storage.sync.set(options).then(() => {
        browser.contextMenus.update("toggle-includeTemplate", {
            checked: options.includeTemplate
        });
        try {
            browser.contextMenus.update("tabtoggle-includeTemplate", {
                checked: options.includeTemplate
            });
        } catch { }
        return clipSite()
    }).catch((error) => {
        console.error(error);
    });
}

const toggleDownloadImages = options => {
    options.downloadImages = !options.downloadImages;
    document.querySelector("#downloadImages").classList.toggle("checked");
    browser.storage.sync.set(options).then(() => {
        browser.contextMenus.update("toggle-downloadImages", {
            checked: options.downloadImages
        });
        try {
            browser.contextMenus.update("tabtoggle-downloadImages", {
                checked: options.downloadImages
            });
        } catch { }
    }).catch((error) => {
        console.error(error);
    });
}
const showOrHideClipOption = selection => {
    if (selection) {
        document.getElementById("clipOption").style.display = "flex";
    }
    else {
        document.getElementById("clipOption").style.display = "none";
    }
}

const clipSite = id => {
    return browser.tabs.executeScript(id, { code: "getSelectionAndDom()" })
        .then((result) => {
            if (result && result[0]) {
                showOrHideClipOption(result[0].selection);
                let message = {
                    type: "clip",
                    dom: result[0].dom,
                    selection: result[0].selection
                }
                return browser.storage.sync.get(defaultOptions).then(options => {
                    browser.runtime.sendMessage({
                        ...message,
                        ...options
                    });
                }).catch(err => {
                    console.error(err);
                    showError(err)
                    return browser.runtime.sendMessage({
                        ...message,
                        ...defaultOptions
                    });
                }).catch(err => {
                    console.error(err);
                    showError(err)
                });
            }
        }).catch(err => {
            console.error(err);
            showError(err)
        });
}

// Add Mistral integration function
let currentController = null; // For cancelling requests

// Function to get cache key
function getCacheKey(content) {
    return content.trim(); // Simple cache key based on content
}

async function processWithMistral(markdown) {
    const spinner = document.getElementById('spinner');
    const button = document.getElementById('cleanWithClaude');
    const progressBar = document.getElementById('progress');
    spinner.style.display = 'block';
    progressBar.style.width = '0%';
    progressBar.style.display = 'block';
    
    const cacheKey = getCacheKey(markdown);
    if (cleanedContentCache.has(cacheKey)) {
        console.log('Using cached result');
        cm.setValue(cleanedContentCache.get(cacheKey));
        spinner.style.display = 'none';
        progressBar.style.display = 'none';
        return;
    }

    // Cancel any existing request
    if (currentController) {
        currentController.abort();
    }
    currentController = new AbortController();
    
    try {
        // Get the current options to access the API key
        const options = await browser.storage.sync.get(['mistralApiKey']);
        
        if (!options.mistralApiKey) {
            throw new Error('Please set your Mistral API key in the extension options');
        }

        const prompt = `You are a specialized content formatter focused on converting messy web content into clean, well-structured Markdown. Apply these rules to clean and format the following content:

FORMATTING SPECIFICATIONS:
- Use ATX-style headers (# H1, ## H2, etc.)
- Leave one blank line before and after headers
- Use triple backticks with language specification for code blocks
- Use hyphens (-) for unordered lists
- Use reference-style links for repeated URLs
- Preserve all code syntax and technical accuracy
- Maintain documentation-specific formatting
- Keep important metadata
- Preserve version numbers and compatibility notes

TECHNICAL REQUIREMENTS:
- Keep all function signatures and parameters intact
- Preserve code examples with proper syntax highlighting
- Maintain any type annotations or return value documentation
- Keep important warning or note blocks
- Handle inline code with single backticks

Here's the content to clean and format:

${markdown}`;

        console.log('Making Mistral API request...');
        const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${options.mistralApiKey}`,
                'Accept': 'application/json',
                'Origin': chrome.runtime.getURL(''),
                'Access-Control-Allow-Origin': '*'
            },
            mode: 'cors',
            credentials: 'omit',
            body: JSON.stringify({
                model: 'mistral-large-latest',
                messages: [{
                    role: 'user',
                    content: prompt
                }],
                stream: true
            }),
            signal: currentController.signal
        });

        if (!response.ok) {
            const errorText = await response.text();
            let errorMessage;
            try {
                const errorData = JSON.parse(errorText);
                errorMessage = errorData.error?.message || `API request failed: ${response.status}`;
            } catch (e) {
                errorMessage = `API request failed: ${response.status} - ${errorText}`;
            }
            throw new Error(errorMessage);
        }

        // Handle streaming response
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let accumulatedText = '';
        let totalChunks = 0;
        let processedChunks = 0;

        // Enable scrolling during streaming
        const editor = cm.getWrapperElement();
        editor.style.pointerEvents = 'auto';
        cm.setOption('readOnly', false);

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            totalChunks++;
            processedChunks++;
            const progress = Math.min((processedChunks / (totalChunks + 5)) * 100, 95);
            progressBar.style.width = `${progress}%`;

            const chunk = decoder.decode(value);
            const lines = chunk.split('\n');
            
            for (const line of lines) {
                if (line.trim() === '') continue;
                if (line === 'data: [DONE]') continue;
                
                try {
                    const data = JSON.parse(line.replace('data: ', ''));
                    if (data.choices && data.choices[0].delta.content) {
                        accumulatedText += data.choices[0].delta.content;
                        cm.setValue(accumulatedText);
                        
                        // Ensure cursor stays at bottom unless user has scrolled
                        if (editor.scrollTop + editor.clientHeight >= editor.scrollHeight - 50) {
                            cm.scrollIntoView(cm.lastLine());
                        }
                    }
                } catch (e) {
                    console.warn('Error parsing streaming response:', e);
                }
            }
        }

        cleanedMarkdown = accumulatedText;
        // Cache the result
        cleanedContentCache.set(cacheKey, accumulatedText);
        progressBar.style.width = '100%';
        
        // Hide progress bar after a short delay
        setTimeout(() => {
            progressBar.style.display = 'none';
        }, 500);

    } catch (error) {
        console.error('Mistral API Error:', error);
        if (error.name === 'AbortError') {
            showError('Request cancelled');
        } else {
            showError('Error processing with Mistral: ' + error.message);
        }
        // Keep the original content and remove checked state
        button.classList.remove("checked");
        // Don't revert the content if we're showing an error
        if (error.message.includes('Please set your Mistral API key')) {
            cm.setValue(originalMarkdown);
        }
    } finally {
        spinner.style.display = 'none';
        currentController = null;
    }
}

// Add event listener for Mistral button
document.getElementById('cleanWithClaude').addEventListener('click', async (e) => {
    e.preventDefault();
    const button = e.target.closest('.button');
    
    if (button.classList.contains("checked")) {
        // Cancel any in-progress request
        if (currentController) {
            currentController.abort();
        }
        // Switch back to original content
        button.classList.remove("checked");
        cm.setValue(originalMarkdown);
    } else {
        // Process with Mistral
        button.classList.add("checked"); // Add checked state immediately
        originalMarkdown = cm.getValue();
        await processWithMistral(originalMarkdown);
    }
});

// Add handlers for text selection mode
document.getElementById('selected').addEventListener('click', (e) => {
    e.preventDefault();
    document.body.classList.add('selecting-text');
    
    // Listen for escape key to exit selection mode
    const escHandler = (e) => {
        if (e.key === 'Escape') {
            document.body.classList.remove('selecting-text');
            window.removeEventListener('keydown', escHandler);
        }
    };
    window.addEventListener('keydown', escHandler);
});

// Update the extension button click handler
browser.browserAction.onClicked.addListener((tab) => {
    if (document.body.classList.contains('selecting-text')) {
        document.body.classList.remove('selecting-text');
    }
});

// inject the necessary scripts
browser.storage.sync.get(defaultOptions).then(options => {
    checkInitialSettings(options);
    
    document.getElementById("selected").addEventListener("click", (e) => {
        e.preventDefault();
        toggleClipSelection(options);
    });
    document.getElementById("document").addEventListener("click", (e) => {
        e.preventDefault();
        toggleClipSelection(options);
    });
    document.getElementById("includeTemplate").addEventListener("click", (e) => {
        e.preventDefault();
        toggleIncludeTemplate(options);
    });
    document.getElementById("downloadImages").addEventListener("click", (e) => {
        e.preventDefault();
        toggleDownloadImages(options);
    });

    return browser.tabs.query({
        currentWindow: true,
        active: true
    });
}).then((tabs) => {
    var id = tabs[0].id;
    var url = tabs[0].url;
    browser.tabs.executeScript(id, {
        file: "/browser-polyfill.min.js"
    })
    .then(() => {
        return browser.tabs.executeScript(id, {
            file: "/contentScript/contentScript.js"
        });
    }).then( () => {
        console.info("Successfully injected MarkDownload content script");
        return clipSite(id);
    }).catch( (error) => {
        console.error(error);
        showError(error);
    });
});

// listen for notifications from the background page
browser.runtime.onMessage.addListener(notify);

//function to send the download message to the background page
function sendDownloadMessage(text) {
    if (text != null) {

        return browser.tabs.query({
            currentWindow: true,
            active: true
        }).then(tabs => {
            var message = {
                type: "download",
                markdown: text,
                title: document.getElementById("title").value,
                tab: tabs[0],
                imageList: imageList,
                mdClipsFolder: mdClipsFolder
            };
            return browser.runtime.sendMessage(message);
        });
    }
}

// event handler for download button
async function download(e) {
    e.preventDefault();
    await sendDownloadMessage(cm.getValue());
    //window.close();
}

// event handler for download selected button
async function downloadSelection(e) {
    e.preventDefault();
    if (cm.somethingSelected()) {
        await sendDownloadMessage(cm.getSelection());
    }
}

//function that handles messages from the injected script into the site
function notify(message) {
    // message for displaying markdown
    if (message.type == "display.md") {

        // set the values from the message
        //document.getElementById("md").value = message.markdown;
        cm.setValue(message.markdown);
        document.getElementById("title").value = message.article.title;
        imageList = message.imageList;
        mdClipsFolder = message.mdClipsFolder;
        
        // show the hidden elements
        document.getElementById("container").style.display = 'flex';
        document.getElementById("spinner").style.display = 'none';
         // focus the download button
        document.getElementById("download").focus();
        cm.refresh();
    }
}

function showError(err) {
    // show the hidden elements
    document.getElementById("container").style.display = 'flex';
    document.getElementById("spinner").style.display = 'none';
    cm.setValue(`Error clipping the page\n\n${err}`)
}
