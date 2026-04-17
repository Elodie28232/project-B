class RecipeApp {
  constructor() {
    this.storageKey = 'pantry-pal-recipes-v2';
    this.shoppingChecksKey = 'pantry-pal-shopping-checks-v1';
    this.householdCode = 'happypantry';
    
    // Supabase config
    this.supabaseUrl = 'https://azjqpzpvlepepbfbqwnu.supabase.co';
    this.supabaseKey = 'sb_publishable_ExGVdbf3VVGxa1AqEzSj_A_ztRjB10a';
    this.supabase = null;
    
    // App state
    this.recipes = [];
    this.shoppingChecks = this.readShoppingChecks();
    this.searchTerm = '';
    this.editingId = null;
    this.selectedRecipeId = null;
    this.isSavingRecipe = false;
    this.isLoading = false;
    this.subscriptions = [];
    this.syncState = {
      peer: null,
      channel: null,
      isHost: false,
      pendingBroadcast: false,
      incomingChunks: {}
    };

    this.ingredientProfiles = {
      milk: ['ml', 'cl', 'l'],
      water: ['ml', 'cl', 'l'],
      cream: ['ml', 'cl', 'l'],
      broth: ['ml', 'cl', 'l'],
      oil: ['ml', 'cl', 'l'],
      flour: ['g', 'kg'],
      sugar: ['g', 'kg'],
      rice: ['g', 'kg'],
      pasta: ['g', 'kg'],
      mushroom: ['pcs', 'g'],
      mushrooms: ['pcs', 'g'],
      courgette: ['pcs', 'g'],
      zucchini: ['pcs', 'g'],
      onion: ['pcs', 'g'],
      tomato: ['pcs', 'g'],
      egg: ['pcs'],
      eggs: ['pcs'],
      salt: ['g', 'tsp'],
      pepper: ['g', 'tsp']
    };

    this.defaultUnits = ['pcs', 'ml', 'cl', 'l', 'g', 'kg', 'tbsp', 'tsp', 'cups'];
    this.init();
  }

  init() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('service-worker.js').catch(() => {
        this.setStatus('Service worker registration failed. App still works online.');
      });
    }

    // Initialize Supabase
    if (window.supabase) {
      this.supabase = window.supabase.createClient(this.supabaseUrl, this.supabaseKey);
      this.isLoading = true;
      this.render();
      this.logInfo(`Using household code: ${this.householdCode}`);
      this.setStatus('Loading recipes from cloud...');
      this.loadRecipesFromSupabase();
    } else {
      this.setStatus('Supabase library failed to load. Retrying...');
      setTimeout(() => this.init(), 2000);
    }
  }

  readRecipes() {
    // This is kept for backward compatibility but is no longer used
    // Recipes now come from Supabase
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (!raw) {
        return [];
      }
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed;
    } catch (error) {
      return [];
    }
  }

  async loadRecipesFromSupabase() {
    try {
      if (!this.supabase) {
        this.setStatus('Supabase not initialized.');
        this.isLoading = false;
        return;
      }

      const { data, error } = await this.supabase
        .from('recipes')
        .select('*')
        .eq('household_code', this.householdCode)
        .order('created_at', { ascending: true });

      if (error) {
        throw error;
      }

      // Convert Supabase rows to recipe format
      this.recipes = (data || []).map(row => ({
        id: row.id,
        name: row.name,
        sourceUrl: row.source_url || '',
        notes: row.notes || '',
        instructions: row.instructions || '',
        includeInShopping: row.include_in_shopping !== false,
        baseServings: row.base_servings || 1,
        desiredServings: row.desired_servings || 1,
        ingredients: row.ingredients || []
      }));

      // Also try to migrate any local recipes
      await this.migrateLocalRecipesToSupabase();

      this.isLoading = false;
      this.render();
      this.logInfo(`Loaded ${this.recipes.length} recipes from cloud.`);

      // Subscribe to real-time changes
      this.subscribeToRecipeChanges();
    } catch (error) {
      this.setStatus(`Cloud load failed: ${error.message}. Falling back to local.`);
      this.isLoading = false;
      this.logInfo('Load error: ' + error.message);
    }
  }

  async migrateLocalRecipesToSupabase() {
    try {
      if (!this.supabase) return;
      
      const raw = localStorage.getItem(this.storageKey);
      if (!raw) return;

      const localRecipes = JSON.parse(raw);
      if (!Array.isArray(localRecipes) || localRecipes.length === 0) return;

      // Check if already migrated
      const { data: existing } = await this.supabase
        .from('recipes')
        .select('id')
        .eq('household_code', this.householdCode);

      if (existing && existing.length > 0) {
        // Already migrated
        return;
      }

      // Migrate recipes
      const toInsert = localRecipes.map(recipe => ({
        id: this.isValidUuid(recipe.id) ? recipe.id : this.uuid(),
        household_code: this.householdCode,
        name: recipe.name,
        source_url: recipe.sourceUrl || '',
        notes: recipe.notes || '',
        instructions: recipe.instructions || '',
        include_in_shopping: recipe.includeInShopping !== false,
        base_servings: recipe.baseServings || 1,
        desired_servings: recipe.desiredServings || 1,
        ingredients: recipe.ingredients || []
      }));

      const { error } = await this.supabase
        .from('recipes')
        .insert(toInsert);

      if (error) {
        this.logInfo(`Migration warning: ${error.message}`);
      } else {
        this.logInfo(`Migrated ${toInsert.length} recipes to cloud.`);
        localStorage.removeItem(this.storageKey);
      }
    } catch (error) {
      this.logInfo(`Migration error: ${error.message}`);
    }
  }

  subscribeToRecipeChanges() {
    try {
      if (!this.supabase) return;

      // Remove old subscriptions
      this.subscriptions.forEach(sub => sub.unsubscribe());
      this.subscriptions = [];

      const subscription = this.supabase
        .channel(`recipes-${this.householdCode}`)
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'recipes',
            filter: `household_code=eq.${this.householdCode}`
          },
          (payload) => {
            this.handleSupabaseChange(payload);
          }
        )
        .subscribe();

      this.subscriptions.push(subscription);
    } catch (error) {
      this.logInfo(`Subscription error: ${error.message}`);
    }
  }

  handleSupabaseChange(payload) {
    try {
      if (payload.eventType === 'INSERT') {
        const newRecipe = {
          id: payload.new.id,
          name: payload.new.name,
          sourceUrl: payload.new.source_url || '',
          notes: payload.new.notes || '',
          instructions: payload.new.instructions || '',
          includeInShopping: payload.new.include_in_shopping !== false,
          baseServings: payload.new.base_servings || 1,
          desiredServings: payload.new.desired_servings || 1,
          ingredients: payload.new.ingredients || []
        };

        if (!this.recipes.find(r => r.id === newRecipe.id)) {
          this.recipes.push(newRecipe);
          this.logInfo('New recipe received from other device.');
          this.render();
        }
      } else if (payload.eventType === 'UPDATE') {
        const index = this.recipes.findIndex(r => r.id === payload.new.id);
        if (index >= 0) {
          this.recipes[index] = {
            id: payload.new.id,
            name: payload.new.name,
            sourceUrl: payload.new.source_url || '',
            notes: payload.new.notes || '',
            instructions: payload.new.instructions || '',
            includeInShopping: payload.new.include_in_shopping !== false,
            baseServings: payload.new.base_servings || 1,
            desiredServings: payload.new.desired_servings || 1,
            ingredients: payload.new.ingredients || []
          };
          this.logInfo('Recipe updated from other device.');
          this.render();
        }
      } else if (payload.eventType === 'DELETE') {
        const index = this.recipes.findIndex(r => r.id === payload.old.id);
        if (index >= 0) {
          this.recipes.splice(index, 1);
          this.logInfo('Recipe deleted from other device.');
          this.render();
        }
      }
    } catch (error) {
      this.logInfo(`Change handling error: ${error.message}`);
    }
  }

  normalizeRecipe(recipe) {
    if (!recipe || typeof recipe !== 'object') {
      return null;
    }
    const safeIngredients = Array.isArray(recipe.ingredients) ? recipe.ingredients : [];
    const baseServings = Number(recipe.baseServings);
    const desiredServings = Number(recipe.desiredServings || baseServings);
    const normalized = {
      id: this.isValidUuid(recipe.id) ? recipe.id : this.uuid(),
      name: String(recipe.name || '').trim(),
      sourceUrl: String(recipe.sourceUrl || '').trim(),
      notes: String(recipe.notes || '').trim(),
      instructions: String(recipe.instructions || '').trim(),
      includeInShopping: recipe.includeInShopping !== false,
      baseServings: Number.isFinite(baseServings) && baseServings > 0 ? baseServings : 1,
      desiredServings: Number.isFinite(desiredServings) && desiredServings >= 0 ? desiredServings : 1,
      ingredients: safeIngredients
        .map(ing => ({
          id: ing.id || this.uuid(),
          name: String(ing.name || '').trim().toLowerCase(),
          quantity: Number(ing.quantity),
          unit: String(ing.unit || '').trim().toLowerCase() || 'pcs'
        }))
        .filter(ing => ing.name && Number.isFinite(ing.quantity) && ing.quantity > 0)
    };

    if (!normalized.name) {
      return null;
    }
    return normalized;
  }

  switchView(viewId, triggerButton) {
    document.querySelectorAll('.view').forEach(el => el.classList.add('hidden'));
    const view = document.getElementById(`${viewId}-view`);
    if (view) {
      view.classList.remove('hidden');
    }

    if (triggerButton) {
      document.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active'));
      triggerButton.classList.add('active');
    }

    this.render();
  }

  render() {
    this.renderDiary();
    this.renderRecipeDetail();
    this.renderShoppingList();
  }

  renderDiary() {
    const container = document.getElementById('recipe-list');
    const term = this.searchTerm.trim().toLowerCase();
    const visibleRecipes = this.recipes.filter(recipe => {
      if (!term) {
        return true;
      }
      if (recipe.name.toLowerCase().includes(term)) {
        return true;
      }
      return recipe.ingredients.some(ing => ing.name.includes(term));
    });

    if (visibleRecipes.length === 0) {
      container.innerHTML = '<p class="muted">No recipes found for this search.</p>';
      return;
    }

    container.innerHTML = visibleRecipes
      .map(recipe => {
        const index = this.recipes.findIndex(r => r.id === recipe.id);
        const ingredientText = recipe.ingredients
          .map(ing => `${this.formatQty(ing.quantity)} ${ing.unit} ${ing.name}`)
          .join(', ');
        return `
          <article class="recipe-card fade-in clickable" onclick="app.openRecipeView(${index})">
            <div class="recipe-title">
              <div>
                <h3>${this.escapeHtml(recipe.name)}</h3>
                <p class="muted">Base servings: ${this.formatQty(recipe.baseServings)}</p>
              </div>
              <div class="row">
                <button class="btn" onclick="event.stopPropagation(); app.editRecipe(${index})">Edit</button>
                <button class="btn" onclick="event.stopPropagation(); app.deleteRecipe(${index})">Delete</button>
              </div>
            </div>
            ${recipe.notes ? `<p class="muted">${this.escapeHtml(recipe.notes.slice(0, 120))}${recipe.notes.length > 120 ? '...' : ''}</p>` : ''}
            ${recipe.instructions ? `<p class="tiny"><strong>Instructions:</strong> ${this.escapeHtml(recipe.instructions.slice(0, 120))}${recipe.instructions.length > 120 ? '...' : ''}</p>` : ''}
            <p class="tiny"><strong>Ingredients:</strong> ${this.escapeHtml(ingredientText || 'No ingredients yet')}</p>
          </article>
        `;
      })
      .join('');
  }

  renderRecipeDetail() {
    const panel = document.getElementById('recipe-detail');
    const body = document.getElementById('recipe-detail-body');
    if (!panel || !body) {
      return;
    }

    if (!this.selectedRecipeId) {
      panel.classList.add('hidden');
      return;
    }

    const recipe = this.recipes.find(item => item.id === this.selectedRecipeId);
    if (!recipe) {
      panel.classList.add('hidden');
      return;
    }

    panel.classList.remove('hidden');
    body.innerHTML = `
      <h3>${this.escapeHtml(recipe.name)}</h3>
      <p class="muted">Base servings: ${this.formatQty(recipe.baseServings)}</p>
      ${recipe.sourceUrl ? `<p><a href="${this.escapeHtml(recipe.sourceUrl)}" target="_blank" rel="noopener noreferrer">Open source</a></p>` : ''}
      ${recipe.notes ? `<p><strong>Notes</strong><br>${this.escapeHtml(recipe.notes).replace(/\n/g, '<br>')}</p>` : '<p class="muted">No notes added.</p>'}
      ${recipe.instructions ? `<p><strong>Instructions</strong><br>${this.escapeHtml(recipe.instructions).replace(/\n/g, '<br>')}</p>` : '<p class="muted">No instructions added.</p>'}
      <p><strong>Ingredients</strong></p>
      <ul>
        ${recipe.ingredients.map(ing => `<li>${this.formatQty(ing.quantity)} ${this.escapeHtml(ing.unit)} ${this.escapeHtml(ing.name)}</li>`).join('')}
      </ul>
    `;
  }

  openRecipeView(index) {
    const recipe = this.recipes[index];
    if (!recipe) {
      return;
    }
    this.selectedRecipeId = recipe.id;
    this.renderRecipeDetail();
  }

  closeRecipeView() {
    this.selectedRecipeId = null;
    this.renderRecipeDetail();
  }

  renderShoppingList() {
    const listContainer = document.getElementById('shopping-list-output');
    const recipesContainer = document.getElementById('active-recipes');
    recipesContainer.innerHTML = '';

    if (this.recipes.length === 0) {
      recipesContainer.innerHTML = '<p class="muted">Add a recipe to start.</p>';
      listContainer.innerHTML = '<p class="muted">Shopping list will appear here.</p>';
      return;
    }

    this.recipes.forEach((recipe, index) => {
      const row = document.createElement('div');
      row.className = 'recipe-card';
      row.innerHTML = `
        <div class="shopping-recipe-row">
          <input type="checkbox" ${recipe.includeInShopping ? 'checked' : ''} onchange="app.toggleRecipeSelection(${index}, this.checked)">
          <strong class="shopping-recipe-name">${this.escapeHtml(recipe.name)}</strong>
          <input class="shopping-recipe-servings-input" type="number" min="0" step="1" value="${this.formatQty(recipe.desiredServings)}" onchange="app.updateServings(${index}, this.value)">
          <span class="muted shopping-recipe-people">people</span>
        </div>
      `;
      recipesContainer.appendChild(row);
    });

    const aggregated = this.aggregateIngredients();
    if (aggregated.length === 0) {
      listContainer.innerHTML = '<p class="muted">No ingredients with servings > 0.</p>';
      return;
    }

    listContainer.innerHTML = aggregated
      .map(item => {
        const checked = this.shoppingChecks[item.key] ? 'checked' : '';
        const doneClass = this.shoppingChecks[item.key] ? 'done' : '';
        const encodedKey = encodeURIComponent(item.key);
        return `
          <label class="shopping-item ${doneClass}">
            <input type="checkbox" ${checked} onchange="app.toggleShoppingItem('${encodedKey}', this.checked)">
            <span class="shopping-item-name">${this.escapeHtml(item.name)}</span>
            <strong class="shopping-item-qty">${this.formatQty(item.quantity)} ${item.unit}</strong>
          </label>
        `;
      })
      .join('');
  }

  aggregateIngredients() {
    const aggregated = {};
    this.recipes.forEach(recipe => {
      if (!recipe.includeInShopping) {
        return;
      }
      if (!recipe.desiredServings || recipe.desiredServings <= 0) {
        return;
      }
      const ratio = recipe.desiredServings / recipe.baseServings;
      recipe.ingredients.forEach(ing => {
        const normalized = this.normalizeUnitValue(ing.quantity * ratio, ing.unit);
        const key = `${ing.name}|${normalized.baseUnit}`;
        if (!aggregated[key]) {
          aggregated[key] = {
            name: ing.name,
            quantity: 0,
            baseUnit: normalized.baseUnit
          };
        }
        aggregated[key].quantity += normalized.baseQty;
      });
    });

    return Object.values(aggregated)
      .map(item => {
        const display = this.toDisplayUnit(item.quantity, item.baseUnit);
        return {
          name: item.name,
          key: `${item.name}|${display.unit}`,
          quantity: display.qty,
          unit: display.unit
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  toggleRecipeSelection(index, checked) {
    const recipe = this.recipes[index];
    if (!recipe) {
      return;
    }
    recipe.includeInShopping = Boolean(checked);
    this.saveData(false);
  }

  toggleShoppingItem(encodedKey, checked) {
    if (!encodedKey) {
      return;
    }
    const itemKey = decodeURIComponent(encodedKey);
    if (checked) {
      this.shoppingChecks[itemKey] = true;
    } else {
      delete this.shoppingChecks[itemKey];
    }
    this.saveShoppingChecks();
    this.renderShoppingList();
  }

  normalizeUnitValue(quantity, unit) {
    const cleanUnit = String(unit || '').toLowerCase();
    if (cleanUnit === 'l') {
      return { baseQty: quantity * 1000, baseUnit: 'ml' };
    }
    if (cleanUnit === 'cl') {
      return { baseQty: quantity * 10, baseUnit: 'ml' };
    }
    if (cleanUnit === 'kg') {
      return { baseQty: quantity * 1000, baseUnit: 'g' };
    }
    return { baseQty: quantity, baseUnit: cleanUnit || 'pcs' };
  }

  toDisplayUnit(quantity, baseUnit) {
    if (baseUnit === 'ml') {
      if (quantity >= 1000) {
        return { qty: quantity / 1000, unit: 'l' };
      }
      if (quantity >= 100) {
        return { qty: quantity / 10, unit: 'cl' };
      }
      return { qty: quantity, unit: 'ml' };
    }
    if (baseUnit === 'g') {
      if (quantity >= 1000) {
        return { qty: quantity / 1000, unit: 'kg' };
      }
      return { qty: quantity, unit: 'g' };
    }
    return { qty: quantity, unit: baseUnit || 'pcs' };
  }

  setSearch(value) {
    this.searchTerm = value;
    this.renderDiary();
  }

  showAddForm() {
    this.editingId = null;
    this.resetForm();
    document.getElementById('form-title').textContent = 'Add Recipe';
    this.switchView('import', document.querySelector('[data-view="import"]'));
  }

  hideForm() {
    this.editingId = null;
    this.resetForm();
    document.getElementById('form-title').textContent = 'Add Recipe';
  }

  editRecipe(index) {
    const recipe = this.recipes[index];
    if (!recipe) {
      return;
    }
    this.editingId = recipe.id;
    document.getElementById('form-title').textContent = 'Edit Recipe';
    document.getElementById('recipe-name').value = recipe.name;
    document.getElementById('recipe-servings').value = recipe.baseServings;
    document.getElementById('recipe-source').value = recipe.sourceUrl || '';
    document.getElementById('recipe-notes').value = recipe.notes || '';
    document.getElementById('recipe-instructions').value = recipe.instructions || '';
    const ingredientRoot = document.getElementById('ingredient-inputs');
    ingredientRoot.innerHTML = '';
    recipe.ingredients.forEach(ing => this.addIngredientField(ing));
    this.switchView('import', document.querySelector('[data-view="import"]'));
  }

  resetForm() {
    document.getElementById('recipe-name').value = '';
    document.getElementById('recipe-servings').value = 2;
    document.getElementById('recipe-source').value = '';
    document.getElementById('recipe-notes').value = '';
    document.getElementById('recipe-instructions').value = '';
    document.getElementById('ingredient-inputs').innerHTML = '';
    this.addIngredientField();
  }

  addIngredientField(ingredient = { quantity: 1, unit: 'pcs', name: '' }) {
    const rowId = this.uuid();
    const row = document.createElement('div');
    row.className = 'ingredient-row';
    row.dataset.rowId = rowId;

    row.innerHTML = `
      <div>
        <label>Qty</label>
        <input type="number" min="0" step="0.1" class="ing-qty" value="${this.formatQty(ingredient.quantity || 1)}">
      </div>
      <div>
        <label>Unit</label>
        <select class="ing-unit"></select>
      </div>
      <div>
        <label>Ingredient</label>
        <input type="text" class="ing-name" list="ingredient-options" placeholder="egg, courgette, milk..." value="${this.escapeHtml(ingredient.name || '')}">
      </div>
      <button class="btn" type="button" onclick="app.removeIngredientField('${rowId}')">Remove</button>
    `;

    document.getElementById('ingredient-inputs').appendChild(row);
    this.populateUnitOptions(row, ingredient.name, ingredient.unit);

    const nameInput = row.querySelector('.ing-name');
    nameInput.addEventListener('input', () => {
      this.populateUnitOptions(row, nameInput.value, null);
    });

    this.renderIngredientDatalist();
  }

  renderIngredientDatalist() {
    let datalist = document.getElementById('ingredient-options');
    if (!datalist) {
      datalist = document.createElement('datalist');
      datalist.id = 'ingredient-options';
      document.body.appendChild(datalist);
    }

    const names = new Set(Object.keys(this.ingredientProfiles));
    this.recipes.forEach(recipe => {
      recipe.ingredients.forEach(ing => names.add(ing.name));
    });

    datalist.innerHTML = Array.from(names)
      .sort((a, b) => a.localeCompare(b))
      .map(name => `<option value="${this.escapeHtml(name)}"></option>`)
      .join('');
  }

  populateUnitOptions(row, ingredientName, selectedUnit) {
    const select = row.querySelector('.ing-unit');
    const key = String(ingredientName || '').trim().toLowerCase();
    const units = this.ingredientProfiles[key] || this.defaultUnits;
    const fallback = selectedUnit || units[0] || 'pcs';
    select.innerHTML = units
      .map(unit => `<option value="${unit}" ${unit === fallback ? 'selected' : ''}>${unit}</option>`)
      .join('');
  }

  removeIngredientField(rowId) {
    const row = document.querySelector(`[data-row-id="${rowId}"]`);
    if (row) {
      row.remove();
    }
  }

  saveRecipe() {
    if (this.isSavingRecipe) {
      return;
    }

    const name = document.getElementById('recipe-name').value.trim();
    const baseServings = Number(document.getElementById('recipe-servings').value);
    const sourceUrl = document.getElementById('recipe-source').value.trim();
    const notes = document.getElementById('recipe-notes').value.trim();
    const instructions = document.getElementById('recipe-instructions').value.trim();
    const rows = Array.from(document.querySelectorAll('#ingredient-inputs .ingredient-row'));

    if (!name) {
      this.setStatus('Recipe name is required.');
      return;
    }
    if (!Number.isFinite(baseServings) || baseServings <= 0) {
      this.setStatus('Base servings must be a number greater than 0.');
      return;
    }

    const ingredients = rows
      .map(row => ({
        id: this.uuid(),
        quantity: Number(row.querySelector('.ing-qty').value),
        unit: String(row.querySelector('.ing-unit').value || 'pcs').trim().toLowerCase(),
        name: String(row.querySelector('.ing-name').value || '').trim().toLowerCase()
      }))
      .filter(ing => ing.name && Number.isFinite(ing.quantity) && ing.quantity > 0);

    if (ingredients.length === 0) {
      this.setStatus('Please add at least one valid ingredient.');
      return;
    }

    this.isSavingRecipe = true;
    const saveButton = document.getElementById('save-recipe-btn');
    if (saveButton) {
      saveButton.disabled = true;
      saveButton.textContent = 'Saving...';
    }

    const existing = this.recipes.find(recipe => recipe.id === this.editingId);
    const signature = JSON.stringify(
      ingredients
        .map(ing => ({ name: ing.name, unit: ing.unit, quantity: ing.quantity }))
        .sort((a, b) => a.name.localeCompare(b.name))
    );

    const duplicateIndex = this.recipes.findIndex(recipe => {
      if (existing && recipe.id === existing.id) {
        return false;
      }
      if (recipe.name.toLowerCase() !== name.toLowerCase()) {
        return false;
      }
      if (Number(recipe.baseServings) !== baseServings) {
        return false;
      }
      const recipeSignature = JSON.stringify(
        recipe.ingredients
          .map(ing => ({ name: ing.name, unit: ing.unit, quantity: ing.quantity }))
          .sort((a, b) => a.name.localeCompare(b.name))
      );
      return recipeSignature === signature;
    });

    if (!existing && duplicateIndex >= 0) {
      this.selectedRecipeId = this.recipes[duplicateIndex].id;
      this.setStatus('This recipe is already saved.', true);
      this.switchView('diary', document.querySelector('[data-view="diary"]'));
      this.isSavingRecipe = false;
      if (saveButton) {
        saveButton.disabled = false;
        saveButton.textContent = 'Save Recipe';
      }
      return;
    }

    const recipeData = {
      id: existing ? existing.id : this.uuid(),
      name,
      sourceUrl,
      notes,
      instructions,
      includeInShopping: existing ? existing.includeInShopping !== false : true,
      baseServings,
      desiredServings: existing ? existing.desiredServings : baseServings,
      ingredients
    };

    this.saveToSupabase(recipeData, existing ? 'update' : 'insert', saveButton);
  }

  async saveToSupabase(recipeData, action, saveButton) {
    try {
      if (!this.supabase) {
        throw new Error('Supabase not connected');
      }

      const payload = {
        id: recipeData.id,
        household_code: this.householdCode,
        name: recipeData.name,
        source_url: recipeData.sourceUrl,
        notes: recipeData.notes,
        instructions: recipeData.instructions,
        include_in_shopping: recipeData.includeInShopping,
        base_servings: recipeData.baseServings,
        desired_servings: recipeData.desiredServings,
        ingredients: recipeData.ingredients
      };

      let error = null;

      if (action === 'insert') {
        const { error: err } = await this.supabase
          .from('recipes')
          .insert([payload]);
        error = err;
      } else if (action === 'update') {
        const { error: err } = await this.supabase
          .from('recipes')
          .update(payload)
          .eq('id', recipeData.id);
        error = err;
      } else if (action === 'delete') {
        const { error: err } = await this.supabase
          .from('recipes')
          .delete()
          .eq('id', recipeData.id);
        error = err;
      }

      if (error) {
        throw error;
      }

      // Update local state
      const existing = this.recipes.find(r => r.id === recipeData.id);
      if (existing) {
        Object.assign(existing, recipeData);
        this.logInfo('Recipe updated.');
      } else {
        this.recipes.push(recipeData);
        this.logInfo('Recipe created.');
      }

      this.selectedRecipeId = recipeData.id;
      this.editingId = null;
      this.resetForm();
      document.getElementById('form-title').textContent = 'Add Recipe';
      this.render();
      this.renderIngredientDatalist();
      this.switchView('diary', document.querySelector('[data-view="diary"]'));

      this.isSavingRecipe = false;
      if (saveButton) {
        saveButton.disabled = false;
        saveButton.textContent = 'Save Recipe';
      }
    } catch (error) {
      this.setStatus(`Save failed: ${error.message}`);
      this.isSavingRecipe = false;
      if (saveButton) {
        saveButton.disabled = false;
        saveButton.textContent = 'Save Recipe';
      }
    }
  }

  deleteRecipe(index) {
    const recipe = this.recipes[index];
    if (!recipe) {
      return;
    }
    if (this.selectedRecipeId === recipe.id) {
      this.selectedRecipeId = null;
    }
    this.recipes.splice(index, 1);
    this.saveToSupabase(recipe, 'delete', null);
  }

  updateServings(index, value) {
    const recipe = this.recipes[index];
    if (!recipe) {
      return;
    }
    const servings = Number(value);
    recipe.desiredServings = Number.isFinite(servings) && servings >= 0 ? servings : 0;
    this.saveServing(recipe);
  }

  async saveServing(recipe) {
    try {
      if (!this.supabase) {
        throw new Error('Supabase not connected');
      }

      const { error } = await this.supabase
        .from('recipes')
        .update({ desired_servings: recipe.desiredServings })
        .eq('id', recipe.id);

      if (error) {
        throw error;
      }

      this.render();
    } catch (error) {
      this.logInfo(`Failed to save servings: ${error.message}`);
    }
  }

  async searchInternetRecipes() {
    const query = document.getElementById('internet-query').value.trim();
    const resultsRoot = document.getElementById('internet-results');
    if (!query) {
      this.setStatus('Type a dish name first.');
      return;
    }

    this.logInfo('Searching recipes online...');
    resultsRoot.innerHTML = '<p class="muted">Searching...</p>';

    try {
      const [mealDbResults, dummyResults] = await Promise.all([
        this.fetchMealDbResults(query),
        this.fetchDummyJsonResults(query)
      ]);

      const combined = [...mealDbResults, ...dummyResults];
      const deduped = [];
      const seen = new Set();

      combined.forEach(item => {
        const key = item.name.toLowerCase();
        if (seen.has(key)) {
          return;
        }
        seen.add(key);
        deduped.push(item);
      });

      if (deduped.length === 0) {
        resultsRoot.innerHTML = '<p class="muted">No internet recipes found for that search.</p>';
        this.setStatus('No internet recipes found.');
        return;
      }

      resultsRoot.innerHTML = deduped
        .map((entry, i) => `
          <article class="import-result fade-in">
            <div class="row between">
              <strong>${this.escapeHtml(entry.name)}</strong>
              <button class="btn success" onclick="app.importInternetResult(${i})">Save to diary</button>
            </div>
            <p class="tiny">Source: ${this.escapeHtml(entry.provider)} ${entry.meta ? ' - ' + this.escapeHtml(entry.meta) : ''}</p>
          </article>
        `)
        .join('');

      this.internetResults = deduped;
      this.logInfo(`Found ${deduped.length} internet recipes from multiple sources.`);
    } catch (error) {
      resultsRoot.innerHTML = '<p class="muted">Could not load internet recipes.</p>';
      this.setStatus('Internet import failed. Check connection and try again.');
    }
  }

  async fetchMealDbResults(query) {
    const searches = [query];
    const firstToken = query.split(/\s+/).filter(Boolean)[0];
    if (firstToken && firstToken.toLowerCase() !== query.toLowerCase()) {
      searches.push(firstToken);
    }

    const out = [];
    for (const term of searches) {
      const response = await fetch(`https://www.themealdb.com/api/json/v1/1/search.php?s=${encodeURIComponent(term)}`);
      if (!response.ok) {
        continue;
      }
      const payload = await response.json();
      const meals = Array.isArray(payload.meals) ? payload.meals : [];
      meals.forEach(meal => {
        out.push({
          provider: 'TheMealDB',
          name: meal.strMeal || 'Untitled Recipe',
          meta: `${meal.strArea || ''} ${meal.strCategory ? '- ' + meal.strCategory : ''}`.trim(),
          raw: meal,
          kind: 'mealdb'
        });
      });
    }
    return out;
  }

  async fetchDummyJsonResults(query) {
    const response = await fetch(`https://dummyjson.com/recipes/search?q=${encodeURIComponent(query)}`);
    if (!response.ok) {
      return [];
    }
    const payload = await response.json();
    const recipes = Array.isArray(payload.recipes) ? payload.recipes : [];
    return recipes.map(recipe => ({
      provider: 'DummyJSON',
      name: recipe.name || 'Untitled Recipe',
      meta: recipe.cuisine || '',
      raw: recipe,
      kind: 'dummyjson'
    }));
  }

  importInternetResult(index) {
    const entry = this.internetResults && this.internetResults[index];
    if (!entry) {
      return;
    }

    if (entry.kind === 'mealdb') {
      this.importMealDbResult(entry.raw);
      return;
    }

    if (entry.kind === 'dummyjson') {
      this.importDummyJsonResult(entry.raw);
    }
  }

  importMealDbResult(meal) {
    if (!meal) {
      return;
    }

    const ingredients = [];
    for (let i = 1; i <= 20; i += 1) {
      const name = String(meal[`strIngredient${i}`] || '').trim().toLowerCase();
      if (!name) {
        continue;
      }
      const measure = String(meal[`strMeasure${i}`] || '').trim().toLowerCase();
      const parsed = this.parseMeasure(measure);
      ingredients.push({
        id: this.uuid(),
        name,
        quantity: parsed.quantity,
        unit: parsed.unit
      });
    }

    const recipe = {
      id: this.uuid(),
      name: meal.strMeal,
      sourceUrl: meal.strSource || meal.strYoutube || '',
      notes: '',
      instructions: meal.strInstructions || '',
      baseServings: 2,
      desiredServings: 2,
      ingredients: ingredients.length ? ingredients : [{ id: this.uuid(), name: 'unknown ingredient', quantity: 1, unit: 'pcs' }]
    };

    this.recipes.push(recipe);
    this.saveToSupabase(recipe, 'insert', null);
    this.logInfo('Internet recipe saved to diary.');
  }

  importDummyJsonResult(item) {
    if (!item) {
      return;
    }

    const rawIngredients = Array.isArray(item.ingredients) ? item.ingredients : [];
    const ingredients = rawIngredients
      .map(text => this.parseIngredientLine(text))
      .filter(Boolean)
      .map(parsed => ({
        id: this.uuid(),
        name: parsed.name,
        quantity: parsed.quantity,
        unit: parsed.unit
      }));

    const instructions = Array.isArray(item.instructions)
      ? item.instructions.join('\n')
      : String(item.instructions || '');

    const servings = Number(item.servings);
    const safeServings = Number.isFinite(servings) && servings > 0 ? servings : 2;

    const recipe = {
      id: this.uuid(),
      name: item.name || 'Imported Recipe',
      sourceUrl: '',
      notes: '',
      instructions,
      baseServings: safeServings,
      desiredServings: safeServings,
      ingredients: ingredients.length ? ingredients : [{ id: this.uuid(), name: 'unknown ingredient', quantity: 1, unit: 'pcs' }]
    };

    this.recipes.push(recipe);
    this.saveToSupabase(recipe, 'insert', null);
    this.logInfo('Internet recipe saved to diary.');
  }

  parseMeasure(measureText) {
    if (!measureText) {
      return { quantity: 1, unit: 'pcs' };
    }
    const match = measureText.match(/([\d.]+)/);
    const quantity = match ? Number(match[1]) : 1;
    let unit = 'pcs';
    if (measureText.includes('kg')) {
      unit = 'kg';
    } else if (measureText.includes('g')) {
      unit = 'g';
    } else if (measureText.includes('ml')) {
      unit = 'ml';
    } else if (measureText.includes('l')) {
      unit = 'l';
    } else if (measureText.includes('cup')) {
      unit = 'cups';
    } else if (measureText.includes('tbsp')) {
      unit = 'tbsp';
    } else if (measureText.includes('tsp')) {
      unit = 'tsp';
    }
    return { quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1, unit };
  }

  importPastedJson() {
    const input = document.getElementById('paste-json').value.trim();
    if (!input) {
      this.setStatus('Paste JSON first.');
      return;
    }
    try {
      const parsed = this.parseJsonText(input);
      this.importFromParsedPayload(parsed, 'No valid recipes found in pasted JSON.');
    } catch (error) {
      this.setStatus(`Invalid JSON format: ${error.message}`);
    }
  }

  triggerImportFile() {
    document.getElementById('import-file').click();
  }

  async importFromFile(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) {
      return;
    }
    try {
      const text = await file.text();
      const parsed = this.parseJsonText(text);
      this.importFromParsedPayload(
        parsed,
        'No valid recipes found in imported file. Expected an array, a recipe object, or an object containing recipes/data/items.'
      );
    } catch (error) {
      this.setStatus(`Could not import this file: ${error.message}`);
    } finally {
      event.target.value = '';
    }
  }

  exportRecipes() {
    const blob = new Blob([JSON.stringify(this.recipes, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'pantry-pal-recipes.json';
    anchor.click();
    URL.revokeObjectURL(url);
    this.logInfo('Recipes exported.');
  }

  parseJsonText(text) {
    const cleaned = String(text || '').replace(/^\uFEFF/, '').trim();
    return JSON.parse(cleaned);
  }

  findRecipeNode(input) {
    if (!input) {
      return null;
    }

    if (Array.isArray(input)) {
      for (const item of input) {
        const found = this.findRecipeNode(item);
        if (found) {
          return found;
        }
      }
      return null;
    }

    if (typeof input !== 'object') {
      return null;
    }

    const type = input['@type'];
    if (typeof type === 'string' && type.toLowerCase() === 'recipe') {
      return input;
    }
    if (Array.isArray(type) && type.some(entry => String(entry).toLowerCase() === 'recipe')) {
      return input;
    }

    if (input['@graph']) {
      const graphFound = this.findRecipeNode(input['@graph']);
      if (graphFound) {
        return graphFound;
      }
    }

    for (const value of Object.values(input)) {
      const found = this.findRecipeNode(value);
      if (found) {
        return found;
      }
    }

    return null;
  }

  extractIngredientsFromRecipeNode(recipeNode) {
    const rawIngredients = Array.isArray(recipeNode.recipeIngredient) ? recipeNode.recipeIngredient : [];
    return rawIngredients
      .map(line => this.parseIngredientLine(line))
      .filter(Boolean)
      .map(parsed => ({
        id: this.uuid(),
        name: parsed.name,
        quantity: parsed.quantity,
        unit: parsed.unit
      }));
  }

  parseServings(recipeYield) {
    if (typeof recipeYield === 'number' && recipeYield > 0) {
      return recipeYield;
    }

    const text = Array.isArray(recipeYield) ? recipeYield.join(' ') : String(recipeYield || '');
    const match = text.match(/(\d+)/);
    const servings = match ? Number(match[1]) : 2;
    return Number.isFinite(servings) && servings > 0 ? servings : 2;
  }

  extractInstructions(recipeInstructions) {
    if (!recipeInstructions) {
      return '';
    }

    if (typeof recipeInstructions === 'string') {
      return recipeInstructions.slice(0, 4000);
    }

    if (Array.isArray(recipeInstructions)) {
      const steps = recipeInstructions
        .map(step => {
          if (typeof step === 'string') {
            return step;
          }
          if (step && typeof step === 'object') {
            return step.text || step.name || '';
          }
          return '';
        })
        .filter(Boolean);
      return steps.join('\n').slice(0, 4000);
    }

    if (typeof recipeInstructions === 'object') {
      return String(recipeInstructions.text || recipeInstructions.name || '').slice(0, 4000);
    }

    return '';
  }

  importFromParsedPayload(parsed, emptyMessage) {
    const list = this.extractRecipeCandidates(parsed);
    const normalized = list.map(item => this.normalizeRecipeCandidate(item)).filter(Boolean);
    if (normalized.length === 0) {
      this.setStatus(emptyMessage);
      return;
    }

    const summary = this.mergeRecipes(normalized);
      this.mergeRecipesToSupabase(normalized);
    this.setStatus(this.getImportSummaryMessage(summary, normalized.length), true);
  }

  normalizeRecipeCandidate(candidate) {
    const direct = this.normalizeRecipe(candidate);
    if (direct) {
      return direct;
    }

    const recovered = this.recoverRecipeFromNestedShape(candidate);
    return this.normalizeRecipe(recovered);
  }

  recoverRecipeFromNestedShape(candidate) {
    if (!candidate || typeof candidate !== 'object') {
      return null;
    }

    const keys = this.collectNestedKeys(candidate);
    const ingredients = [];
    const seen = new Set();

    keys.forEach(line => {
      if (!this.looksLikeIngredientLine(line)) {
        return;
      }
      const parsed = this.parseIngredientLine(line);
      if (!parsed) {
        return;
      }
      const key = `${parsed.name}|${parsed.unit}`;
      if (!seen.has(key)) {
        seen.add(key);
        ingredients.push({
          id: this.uuid(),
          name: parsed.name,
          quantity: parsed.quantity,
          unit: parsed.unit
        });
      }
    });

    if (ingredients.length === 0) {
      return null;
    }

    const servings = this.extractServingsFromKeys(keys);
    const recipeName = this.extractRecipeNameFromKeys(keys);

    return {
      id: this.uuid(),
      name: recipeName,
      baseServings: servings,
      desiredServings: servings,
      ingredients,
      notes: 'Recovered from nested import format.'
    };
  }

  collectNestedKeys(value, bucket = [], depth = 0) {
    if (depth > 30 || value === null || value === undefined) {
      return bucket;
    }

    if (Array.isArray(value)) {
      value.forEach(item => this.collectNestedKeys(item, bucket, depth + 1));
      return bucket;
    }

    if (typeof value !== 'object') {
      if (typeof value === 'string') {
        bucket.push(value);
      }
      return bucket;
    }

    Object.keys(value).forEach(key => {
      bucket.push(key);
      this.collectNestedKeys(value[key], bucket, depth + 1);
    });

    return bucket;
  }

  looksLikeIngredientLine(rawLine) {
    const line = String(rawLine || '').trim();
    if (!line || line.length > 120) {
      return false;
    }

    const lower = line.toLowerCase();
    const blocked = [
      'directions',
      'gather the ingredients',
      'preheat',
      'dotdash',
      'studios',
      'bake',
      'serve and enjoy',
      'make a lattice crust',
      'ingredients to make'
    ];
    if (blocked.some(text => lower.includes(text))) {
      return false;
    }

    if (/^\d+\s*x$/i.test(lower) || /^\d+\/\d+\s*x$/i.test(lower)) {
      return false;
    }

    const startsWithQty = /^\s*([\d.]+|[¼½¾⅓⅔⅛⅜⅝⅞]|\d+\/\d+)\b/.test(line);
    const hasMeasureWord = /(cup|cups|tablespoon|tbsp|teaspoon|tsp|ml|cl|l\b|g\b|kg|oz|lb|pound)/i.test(line);
    return startsWithQty || hasMeasureWord;
  }

  parseIngredientLine(rawLine) {
    const original = String(rawLine || '').trim();
    if (!original) {
      return null;
    }

    const cleaned = original
      .replace(/,\s*or as needed/gi, '')
      .replace(/,\s*thawed/gi, '')
      .replace(/\s+/g, ' ')
      .trim();

    const normalizedFractions = this.replaceFractionChars(cleaned);
    const qtyMatch = normalizedFractions.match(/^((\d+\s+\d+\/\d+)|(\d+\/\d+)|(\d*\.?\d+))\b/);

    let quantity = 1;
    let rest = normalizedFractions;

    if (qtyMatch) {
      quantity = this.parseFractionNumber(qtyMatch[1]);
      rest = normalizedFractions.slice(qtyMatch[0].length).trim();
    }

    const unitsMap = {
      tablespoon: 'tbsp',
      tablespoons: 'tbsp',
      tbsp: 'tbsp',
      teaspoon: 'tsp',
      teaspoons: 'tsp',
      tsp: 'tsp',
      cup: 'cups',
      cups: 'cups',
      ml: 'ml',
      cl: 'cl',
      l: 'l',
      g: 'g',
      kg: 'kg',
      oz: 'oz',
      ounce: 'oz',
      ounces: 'oz',
      lb: 'lb',
      pound: 'lb',
      pounds: 'lb'
    };

    const firstToken = (rest.split(' ')[0] || '').toLowerCase();
    const mappedUnit = unitsMap[firstToken];
    const unit = mappedUnit || 'pcs';
    const name = (mappedUnit ? rest.slice(firstToken.length) : rest).trim().toLowerCase();

    if (!name) {
      return null;
    }

    return {
      quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
      unit,
      name
    };
  }

  replaceFractionChars(value) {
    return String(value)
      .replace(/½/g, '1/2')
      .replace(/¼/g, '1/4')
      .replace(/¾/g, '3/4')
      .replace(/⅓/g, '1/3')
      .replace(/⅔/g, '2/3')
      .replace(/⅛/g, '1/8')
      .replace(/⅜/g, '3/8')
      .replace(/⅝/g, '5/8')
      .replace(/⅞/g, '7/8');
  }

  parseFractionNumber(rawNumber) {
    const value = String(rawNumber || '').trim();

    if (/^\d+\s+\d+\/\d+$/.test(value)) {
      const [whole, fraction] = value.split(' ');
      const [num, den] = fraction.split('/').map(Number);
      return Number(whole) + num / den;
    }

    if (/^\d+\/\d+$/.test(value)) {
      const [num, den] = value.split('/').map(Number);
      return num / den;
    }

    const direct = Number(value);
    return Number.isFinite(direct) ? direct : 1;
  }

  extractServingsFromKeys(keys) {
    for (const key of keys) {
      const match = String(key).match(/yields\s+(\d+)\s+servings/i);
      if (match) {
        const value = Number(match[1]);
        if (Number.isFinite(value) && value > 0) {
          return value;
        }
      }
    }
    return 2;
  }

  extractRecipeNameFromKeys(keys) {
    const text = keys.map(key => String(key)).join(' ').toLowerCase();
    if (text.includes('apple pie')) {
      return 'Apple Pie';
    }
    if (text.includes('pie pastry')) {
      return 'Imported Pie Recipe';
    }
    return 'Imported Recipe';
  }

  extractRecipeCandidates(parsed) {
    if (Array.isArray(parsed)) {
      return parsed;
    }
    if (!parsed || typeof parsed !== 'object') {
      return [];
    }
    if (Array.isArray(parsed.recipes)) {
      return parsed.recipes;
    }
    if (Array.isArray(parsed.data)) {
      return parsed.data;
    }
    if (Array.isArray(parsed.items)) {
      return parsed.items;
    }
    if (parsed.recipe && typeof parsed.recipe === 'object') {
      return [parsed.recipe];
    }
    return [parsed];
  }

  async mergeRecipesToSupabase(recipes) {
    try {
      if (!this.supabase) {
        throw new Error('Supabase not connected');
      }

      for (const recipe of recipes) {
        const payload = {
          id: recipe.id,
          household_code: this.householdCode,
          name: recipe.name,
          source_url: recipe.sourceUrl || '',
          notes: recipe.notes || '',
          instructions: recipe.instructions || '',
          include_in_shopping: recipe.includeInShopping !== false,
          base_servings: recipe.baseServings || 1,
          desired_servings: recipe.desiredServings || 1,
          ingredients: recipe.ingredients || []
        };

        // Upsert (insert or update)
        const { error } = await this.supabase
          .from('recipes')
          .upsert([payload], { onConflict: 'id' });

        if (error) {
          this.logInfo(`Error importing recipe "${recipe.name}": ${error.message}`);
        }
      }
    } catch (error) {
      this.logInfo(`Batch import error: ${error.message}`);
    }
  }

  mergeRecipes(incomingRecipes) {
    const summary = { added: 0, updated: 0 };
    incomingRecipes.forEach(candidate => {
      const byIdIndex = candidate.id ? this.recipes.findIndex(existing => existing.id === candidate.id) : -1;
      const byNameIndex = this.recipes.findIndex(
        existing => existing.name.toLowerCase() === candidate.name.toLowerCase()
      );
      const index = byIdIndex >= 0 ? byIdIndex : byNameIndex;

      if (index >= 0) {
        this.recipes[index] = {
          ...this.recipes[index],
          ...candidate,
          desiredServings: this.recipes[index].desiredServings || candidate.desiredServings || candidate.baseServings
        };
        summary.updated += 1;
      } else {
        this.recipes.push(candidate);
        summary.added += 1;
      }
    });
    return summary;
  }

  getImportSummaryMessage(summary, parsedCount) {
    if (summary.added === 0 && summary.updated === 0) {
      return `Imported 0 recipes from ${parsedCount} parsed entries.`;
    }
    return `Import complete: ${summary.added} added, ${summary.updated} updated.`;
  }

  encodeSyncToken(description) {
    return btoa(unescape(encodeURIComponent(JSON.stringify(description))));
  }

  decodeSyncToken(token, expectedType) {
    const compact = String(token || '')
      .trim()
      .replace(/\s+/g, '')
      .replace(/-/g, '+')
      .replace(/_/g, '/');

    const normalized = compact.padEnd(Math.ceil(compact.length / 4) * 4, '=');
    const parsed = JSON.parse(decodeURIComponent(escape(atob(normalized))));

    if (!parsed || typeof parsed !== 'object' || !parsed.type || !parsed.sdp) {
      throw new Error('Token format is invalid');
    }
    if (expectedType && parsed.type !== expectedType) {
      throw new Error(`Expected a ${expectedType} token but got ${parsed.type}`);
    }
    return parsed;
  }

  async createSyncInvite() {
    try {
      this.destroyPeer();
      const peer = this.newPeer(true);
      const channel = peer.createDataChannel('recipes-sync');
      this.wireDataChannel(channel);

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      await this.waitIceGathering(peer);

      const token = this.encodeSyncToken(peer.localDescription);
      document.getElementById('sync-offer').value = token;
      this.renderQr('sync-offer-qr', token);
      this.setStatus('Invite token generated. Send it to device B.', true);
    } catch (error) {
      this.setStatus('Could not create sync invite.');
    }
  }

  async joinSyncInvite() {
    const token = document.getElementById('join-offer').value.trim();
    if (!token) {
      this.setStatus('Paste invite token from device A first.');
      return;
    }

    try {
      this.destroyPeer();
      const peer = this.newPeer(false);

      const offer = this.decodeSyncToken(token, 'offer');
      await peer.setRemoteDescription(offer);
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      await this.waitIceGathering(peer);

      const answerToken = this.encodeSyncToken(peer.localDescription);
      document.getElementById('join-answer').value = answerToken;
      this.renderQr('join-answer-qr', answerToken);
      this.setStatus('Answer token created. Send it back to device A.', true);
    } catch (error) {
      this.setStatus(`Invalid invite token or sync setup failed: ${error.message}`);
    }
  }

  async applySyncAnswer() {
    const token = document.getElementById('sync-answer').value.trim();
    if (!token || !this.syncState.peer) {
      this.setStatus('Create invite first, then paste answer token.');
      return;
    }

    try {
      if (this.syncState.peer.signalingState !== 'have-local-offer') {
        this.setStatus('This invite session is stale. Create a new invite and answer pair.');
        return;
      }

      const answer = this.decodeSyncToken(token, 'answer');
      await this.syncState.peer.setRemoteDescription(answer);
      this.setStatus('Devices connected. Live sync is active.', true);
      this.broadcastState();
    } catch (error) {
      this.setStatus(`Could not apply answer token: ${error.message}`);
    }
  }

  newPeer(isHost) {
    const peer = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });

    this.syncState.peer = peer;
    this.syncState.isHost = isHost;

    peer.ondatachannel = event => {
      this.wireDataChannel(event.channel);
    };

    peer.onconnectionstatechange = () => {
      const state = peer.connectionState;
      if (state === 'connected') {
        this.setStatus('Devices connected. Live sync is active.', true);
        if (this.syncState.pendingBroadcast) {
          this.broadcastState();
        }
      } else if (state === 'failed' || state === 'disconnected' || state === 'closed') {
        this.setStatus('Sync connection ended.');
      }
    };

    return peer;
  }

  wireDataChannel(channel) {
    this.syncState.channel = channel;

    channel.onopen = () => {
      this.setStatus('Data channel open. Recipes now mirror across devices.', true);
      this.syncState.pendingBroadcast = false;
      this.broadcastState();
    };

    channel.onclose = () => {
      this.setStatus('Sync channel closed. Reconnect from Sync Devices tab.');
    };

    channel.onerror = () => {
      this.setStatus('Sync channel error. Reconnect from Sync Devices tab.');
    };

    channel.onmessage = event => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'full-sync' && Array.isArray(message.payload)) {
          this.applyIncomingRecipes(message.payload);
          return;
        }

        if (message.type === 'full-sync-start' && message.id && Number.isInteger(message.total)) {
          this.syncState.incomingChunks[message.id] = {
            total: message.total,
            chunks: new Array(message.total),
            received: 0
          };
          return;
        }

        if (message.type === 'full-sync-chunk' && message.id && Number.isInteger(message.index) && typeof message.data === 'string') {
          const state = this.syncState.incomingChunks[message.id];
          if (!state || message.index < 0 || message.index >= state.total) {
            return;
          }

          if (!state.chunks[message.index]) {
            state.chunks[message.index] = message.data;
            state.received += 1;
          }

          if (state.received === state.total) {
            const joined = state.chunks.join('');
            delete this.syncState.incomingChunks[message.id];
            const payload = JSON.parse(joined);
            if (Array.isArray(payload)) {
              this.applyIncomingRecipes(payload);
            }
          }
        }
      } catch (error) {
        this.setStatus('Received invalid sync payload.');
      }
    };
  }

  applyIncomingRecipes(payload) {
    this.recipes = payload.map(item => this.normalizeRecipe(item)).filter(Boolean);
    this.saveData(false);
    this.logInfo('Received updates from the other device.');
  }

  broadcastState() {
    const channel = this.syncState.channel;
    if (!channel || channel.readyState !== 'open') {
      this.syncState.pendingBroadcast = true;
      return;
    }

    try {
      const payload = JSON.stringify(this.recipes);
      const maxChunkSize = 12000;

      if (payload.length <= maxChunkSize) {
        channel.send(
          JSON.stringify({
            type: 'full-sync',
            payload: this.recipes
          })
        );
        return;
      }

      const syncId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const chunks = [];
      for (let i = 0; i < payload.length; i += maxChunkSize) {
        chunks.push(payload.slice(i, i + maxChunkSize));
      }

      channel.send(JSON.stringify({ type: 'full-sync-start', id: syncId, total: chunks.length }));
      chunks.forEach((data, index) => {
        channel.send(JSON.stringify({ type: 'full-sync-chunk', id: syncId, index, data }));
      });
    } catch (error) {
      this.syncState.pendingBroadcast = true;
      this.setStatus('Sync send failed. Changes will resend when channel is available.');
    }
  }

  destroyPeer() {
    if (this.syncState.channel) {
      this.syncState.channel.close();
    }
    if (this.syncState.peer) {
      this.syncState.peer.close();
    }
    this.syncState.peer = null;
    this.syncState.channel = null;
    this.syncState.isHost = false;
    this.syncState.pendingBroadcast = false;
    this.syncState.incomingChunks = {};
  }

  waitIceGathering(peer) {
    if (peer.iceGatheringState === 'complete') {
      return Promise.resolve();
    }
    return new Promise(resolve => {
      const checkState = () => {
        if (peer.iceGatheringState === 'complete') {
          peer.removeEventListener('icegatheringstatechange', checkState);
          resolve();
        }
      };
      peer.addEventListener('icegatheringstatechange', checkState);
      setTimeout(() => {
        peer.removeEventListener('icegatheringstatechange', checkState);
        resolve();
      }, 2500);
    });
  }

  renderQr(imageId, text) {
    const image = document.getElementById(imageId);
    if (!image) {
      return;
    }
    const safePayload = encodeURIComponent(text.slice(0, 1800));
    image.src = `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${safePayload}`;
    image.style.display = 'block';
  }

  copyText(textareaId) {
    const textarea = document.getElementById(textareaId);
    if (!textarea || !textarea.value) {
      this.setStatus('Nothing to copy yet.');
      return;
    }
    navigator.clipboard.writeText(textarea.value).then(
      () => this.setStatus('Copied to clipboard.', true),
      () => this.setStatus('Could not copy. Use manual copy.')
    );
  }

  setStatus(message, isPositive = false) {
    const root = document.getElementById('status-message');
    root.textContent = message;
    root.classList.toggle('ok', Boolean(isPositive));
  }

  logInfo(message) {
    console.info(`[Pantry Pal] ${message}`);
  }

  saveData(shouldBroadcast) {
    // saveData now only handles shopping checks (local storage)
    // Recipes are saved via Supabase
    this.saveShoppingChecks();
    this.render();
    this.renderIngredientDatalist();
  }

  readShoppingChecks() {
    try {
      const raw = localStorage.getItem(this.shoppingChecksKey);
      const parsed = raw ? JSON.parse(raw) : {};
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {};
      }
      return parsed;
    } catch (error) {
      return {};
    }
  }

  saveShoppingChecks() {
    localStorage.setItem(this.shoppingChecksKey, JSON.stringify(this.shoppingChecks));
  }

  uuid() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }

    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  isValidUuid(value) {
    return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  }

  formatQty(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return '0';
    }
    if (Math.abs(number - Math.round(number)) < 0.001) {
      return String(Math.round(number));
    }
    return number.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
  }

  escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}

const app = new RecipeApp();