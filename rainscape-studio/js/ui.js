import { getWikiUrl } from './wiki_map.js';

export const UI = {
    /**
     * Create a Control Group (Container for multiple controls)
     */
    createGroup(title, children, collapsible = false) {
        const group = document.createElement('div');
        group.className = `control-group ${collapsible ? 'collapsible' : ''}`;
        
        const header = document.createElement('div');
        header.className = 'group-header';
        header.innerHTML = `<h3 class="group-title">${title}</h3>`;
        
        if (collapsible) {
            const toggleBtn = document.createElement('button');
            toggleBtn.className = 'group-toggle-btn';
            toggleBtn.innerHTML = '▼';
            header.appendChild(toggleBtn);
            
            header.onclick = () => {
                group.classList.toggle('collapsed');
                toggleBtn.innerHTML = group.classList.contains('collapsed') ? '▶' : '▼';
            };
        }

        group.appendChild(header);

        const container = document.createElement('div');
        container.className = 'group-content';
        children.forEach(child => {
            if (Array.isArray(child)) {
                child.forEach(c => container.appendChild(c));
            } else {
                container.appendChild(child);
            }
        });
        
        group.appendChild(container);
        return group;
    },

    /**
     * Create a Parameter Slider
     */
    createSlider(label, options) {
        const { min = 0, max = 100, step = 1, value = 50, unit = '', path, tooltip, onChange } = options;
        
        const wrapper = document.createElement('div');
        wrapper.className = 'control-item slider-item';
        if (tooltip) wrapper.setAttribute('title', tooltip);

        wrapper.innerHTML = `
            <div class="control-label">
                <span class="label-text">${label}</span>
                <span class="label-value mono">${value}${unit}</span>
            </div>
            <div class="control-input">
                <input type="range" min="${min}" max="${max}" step="${step}" value="${value}">
            </div>
        `;

        const input = wrapper.querySelector('input');
        const valueDisplay = wrapper.querySelector('.label-value');

        input.oninput = () => {
            const val = input.value;
            valueDisplay.textContent = `${val}${unit}`;
            if (onChange) onChange(parseFloat(val));
        };

        if (tooltip) UI._addWikiListener(wrapper, label);

        return wrapper;
    },

    /**
     * Create a Toggle Switch
     */
    createToggle(label, options) {
        const { value = false, tooltip, onChange } = options;
        
        const wrapper = document.createElement('div');
        wrapper.className = 'control-item toggle-item';
        if (tooltip) wrapper.setAttribute('title', tooltip);

        wrapper.innerHTML = `
            <span class="label-text">${label}</span>
            <label class="switch">
                <input type="checkbox" ${value ? 'checked' : ''}>
                <span class="slider-round"></span>
            </label>
        `;

        const input = wrapper.querySelector('input');
        input.onchange = () => {
            if (onChange) onChange(input.checked);
        };

        if (tooltip) UI._addWikiListener(wrapper, label);

        return wrapper;
    },

    /**
     * Create a Select Dropdown
     */
    createSelect(label, options) {
        const { items = [], value = '', tooltip, onChange } = options;
        
        const wrapper = document.createElement('div');
        wrapper.className = 'control-item select-item';
        if (tooltip) wrapper.setAttribute('title', tooltip);

        const optionsHtml = items.map(item => 
            `<option value="${item.value || item}" ${value === (item.value || item) ? 'selected' : ''}>${item.label || item}</option>`
        ).join('');

        wrapper.innerHTML = `
            <span class="label-text">${label}</span>
            <select class="custom-select">
                ${optionsHtml}
            </select>
        `;

        const select = wrapper.querySelector('select');
        select.onchange = () => {
            if (onChange) onChange(select.value);
        };

        if (tooltip) UI._addWikiListener(wrapper, label);

        return wrapper;
    },

    /**
     * Internal helper to attach Wiki listener
     */
    _addWikiListener(element, label) {
        element.addEventListener('click', (e) => {
            if (e.ctrlKey) {
                e.preventDefault();
                e.stopPropagation();
                const url = getWikiUrl(label);
                window.open(url, '_blank');
            }
        });
    },

    /**
     * Create a Trigger Button
     */
    createTrigger(label, onClick) {
        const btn = document.createElement('button');
        btn.className = 'btn trigger-btn';
        btn.textContent = label;
        btn.onclick = onClick;
        return btn;
    },

    /**
     * Create a Tabbed Container
     * @param {Object} tabs - Key-value pairs of Label -> Content Element (or function returning element)
     */
    createTabs(tabs) {
        const container = document.createElement('div');
        container.className = 'tab-container';

        const header = document.createElement('div');
        header.className = 'tab-header';

        const content = document.createElement('div');
        content.className = 'tab-content';

        const tabButtons = [];
        const tabPanels = [];

        Object.entries(tabs).forEach(([label, contentGen], index) => {
            // Create Button
            const btn = document.createElement('button');
            btn.className = `tab-btn ${index === 0 ? 'active' : ''}`;
            btn.textContent = label;
            
            // Create Panel
            const panel = document.createElement('div');
            panel.className = `tab-panel ${index === 0 ? 'active' : ''}`;
            
            // Generate content if it's a function, otherwise append node
            if (typeof contentGen === 'function') {
                const elements = contentGen();
                if (Array.isArray(elements)) {
                    elements.forEach(el => panel.appendChild(el));
                } else {
                    panel.appendChild(elements);
                }
            } else {
                panel.appendChild(contentGen);
            }

            // Click Handler
            btn.onclick = () => {
                tabButtons.forEach(b => b.classList.remove('active'));
                tabPanels.forEach(p => p.classList.remove('active'));
                btn.classList.add('active');
                panel.classList.add('active');
            };

            header.appendChild(btn);
            content.appendChild(panel);
            
            tabButtons.push(btn);
            tabPanels.push(panel);
        });

        container.appendChild(header);
        container.appendChild(content);
        return container;
    }
};
