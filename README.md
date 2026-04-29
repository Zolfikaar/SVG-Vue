# SVG to Vue

Generate Vue components instantly from SVG icons.

![Preview](images/preview.png)

---

## Features

* Convert SVG files into reusable Vue components
* Automatically generate a centralized icon system
* Dynamic `<Icon />` component for easy usage
* Optimized SVG output using SVGO
* Clean and consistent icon structure

---

## How It Works

1. Select a folder containing `.svg` files
2. The extension will:

   * Scan all SVG files (recursively)
   * Convert them into Vue components
   * Generate a centralized icon registry
   * Create a dynamic `<Icon />` component

---

## Usage

### 1. Generate Icons

#### Command Palette

* Open Command Palette: `Ctrl + Shift + P`
* Run:

```
SVG to Vue: Generate Components
```

#### Explorer

* Right-click any folder
* Select:

```
SVG to Vue: Generate Components
```

---

### 2. Use Icons in Your App

#### Basic usage

```vue
<Icon name="user-check" />
```

#### With custom size

```vue
<Icon name="user-check" size="32" />
```

---

### 3. Example Output Structure

```
src/
  icons/
    user-check.vue
    arrow-left.vue
    close.vue
    index.ts

  components/
    Icon.vue
```

---

### 4. Direct Component Usage (optional)

```vue
<script setup>
import UserCheck from '@/icons/user-check.vue'
</script>

<template>
  <UserCheck size="24" />
</template>
```

---

## Web Companion

Try the web version:

https://svg-to-vue.app

Install extension directly:

vscode:extension/svg-to-vue.svg-to-vue

---

## Notes

* Icons use `fill="currentColor"` → controlled via CSS
* All unnecessary SVG data is removed
* ViewBox is preserved for proper scaling

---

## Why This Exists

Managing raw SVGs is messy.

This tool turns them into a clean, scalable Vue icon system with minimal effort.
