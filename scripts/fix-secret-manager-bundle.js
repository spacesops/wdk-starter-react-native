#!/usr/bin/env node

/**
 * Post-install script to fix bundle generation for native addon resolution
 * This ensures sodium-native and bare-crypto are properly configured
 */

const fs = require('fs');
const path = require('path');

const providerPath = path.join(__dirname, '..', 'node_modules', '@tetherto', 'wdk-react-native-provider');
const providerImportsFile = path.join(providerPath, 'pack.imports.json');
const providerPackageJsonPath = path.join(providerPath, 'package.json');

// Check both @spacesops and @tetherto (aliased) locations
const pearWrkPathSpacesops = path.join(__dirname, '..', 'node_modules', '@spacesops', 'pear-wrk-wdk');
const pearWrkPathTetherto = path.join(__dirname, '..', 'node_modules', '@tetherto', 'pear-wrk-wdk');
const pearWrkPath = fs.existsSync(pearWrkPathTetherto) ? pearWrkPathTetherto : pearWrkPathSpacesops;
const pearWrkImportsFile = path.join(pearWrkPath, 'pack.imports.json');
const projectRoot = path.join(__dirname, '..');

/**
 * pear-wrk-wdk postinstall runs create-ws-stubs across hoisted node_modules and
 * can drop empty bufferutil/utf-8-validate next to @react-native/dev-middleware's ws.
 * That breaks Expo CLI (ws expects bufferutil.unmask).
 */
function removePearWsStubsFromDevMiddleware () {
  const bases = [
    path.join(projectRoot, 'node_modules', 'expo', 'node_modules', '@react-native', 'dev-middleware', 'node_modules'),
    path.join(projectRoot, 'node_modules', '@react-native', 'dev-middleware', 'node_modules'),
  ];
  for (const nm of bases) {
    if (!fs.existsSync(nm)) continue;
    for (const name of ['bufferutil', 'utf-8-validate']) {
      const pkgDir = path.join(nm, name);
      if (!fs.existsSync(pkgDir)) continue;
      const pkgJson = path.join(pkgDir, 'package.json');
      const indexJs = path.join(pkgDir, 'index.js');
      try {
        const meta = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
        const body = fs.existsSync(indexJs) ? fs.readFileSync(indexJs, 'utf8').trim() : '';
        const isPearStub =
          meta.version === '1.0.0' &&
          meta.main === 'index.js' &&
          body === 'module.exports = {}';
        if (isPearStub) {
          fs.rmSync(pkgDir, { recursive: true, force: true });
          console.log(`Removed pear ws stub from dev-middleware: ${name}`);
        }
      } catch (_) {
        /* ignore */
      }
    }
  }
}

removePearWsStubsFromDevMiddleware();

// Fix secret manager bundle imports
if (fs.existsSync(providerPath)) {
  // Create pack.imports.json if it doesn't exist
  const secretManagerImportsConfig = {
    http: 'bare-http1',
    http2: 'bare-http1',
    bufferutil: 'bufferutil',
    'utf-8-validate': 'utf-8-validate',
    'sodium-native': 'sodium-native',
    'bare-crypto': 'bare-crypto',
    'bare-tcp': 'bare-tcp',
    'bare-performance': 'bare-performance',
  };

  if (!fs.existsSync(providerImportsFile)) {
    fs.writeFileSync(providerImportsFile, JSON.stringify(secretManagerImportsConfig, null, 2) + '\n');
    console.log('Created pack.imports.json for secret manager bundle');
  } else {
    const existing = JSON.parse(fs.readFileSync(providerImportsFile, 'utf8'));
    const updated = { ...existing, ...secretManagerImportsConfig };
    fs.writeFileSync(providerImportsFile, JSON.stringify(updated, null, 2) + '\n');
    console.log('Updated pack.imports.json for secret manager bundle');
  }

  // Update package.json to include --imports flag in gen:secret-manager-bundle script
  if (fs.existsSync(providerPackageJsonPath)) {
    const packageJson = JSON.parse(fs.readFileSync(providerPackageJsonPath, 'utf8'));
    
    if (packageJson.scripts && packageJson.scripts['gen:secret-manager-bundle']) {
      const currentScript = packageJson.scripts['gen:secret-manager-bundle'];
      
      // Check if --imports is already present
      if (!currentScript.includes('--imports')) {
        // Add --imports flag before --out
        const updatedScript = currentScript.replace(
          '--linked --out',
          '--linked --imports pack.imports.json --out'
        );
        
        packageJson.scripts['gen:secret-manager-bundle'] = updatedScript;
        fs.writeFileSync(providerPackageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');
        console.log('Updated gen:secret-manager-bundle script to include --imports flag');
      } else {
        console.log('gen:secret-manager-bundle script already includes --imports flag');
      }
    }
  }
} else {
  console.log('@tetherto/wdk-react-native-provider not found, skipping secret manager bundle fix');
}

// Fix worker bundle imports (used by wdk-worklet.mobile.bundle.js)
if (fs.existsSync(pearWrkPath)) {
  const workerImportsConfig = {
    http: 'bare-http1',
    http2: 'bare-http1',
    bufferutil: 'bufferutil',
    'utf-8-validate': 'utf-8-validate',
    'bare-crypto': 'bare-crypto',
    'bare-performance': 'bare-performance',
    'bare-tcp': 'bare-tcp',
    'sodium-native': 'sodium-native',
  };

  if (!fs.existsSync(pearWrkImportsFile)) {
    fs.writeFileSync(pearWrkImportsFile, JSON.stringify(workerImportsConfig, null, 2) + '\n');
    console.log('Created pack.imports.json for worker bundle');
  } else {
    const existing = JSON.parse(fs.readFileSync(pearWrkImportsFile, 'utf8'));
    const updated = { ...existing, ...workerImportsConfig };
    fs.writeFileSync(pearWrkImportsFile, JSON.stringify(updated, null, 2) + '\n');
    console.log('Updated pack.imports.json for worker bundle (added bare-crypto/bare-performance)');
  }
  
  // Remove nested bare-* modules to ensure bundle uses root versions
  // that match what's linked in the APK (react-native-bare-kit links from root node_modules)
  const nestedBareCrypto = path.join(pearWrkPath, 'node_modules', 'bare-crypto');
  const nestedBarePerformance = path.join(pearWrkPath, 'node_modules', 'bare-performance');
  const nestedBareTcp = path.join(pearWrkPath, 'node_modules', 'bare-tcp');
  
  if (fs.existsSync(nestedBareCrypto)) {
    fs.rmSync(nestedBareCrypto, { recursive: true, force: true });
    console.log('Removed nested bare-crypto to use root version');
  }

  if (fs.existsSync(nestedBarePerformance)) {
    fs.rmSync(nestedBarePerformance, { recursive: true, force: true });
    console.log('Removed nested bare-performance to use root version');
  }
  
  if (fs.existsSync(nestedBareTcp)) {
    fs.rmSync(nestedBareTcp, { recursive: true, force: true });
    console.log('Removed nested bare-tcp to use root version');
  }
  
  // Ensure node_modules exists for create-ws-stubs script
  // The script needs node_modules to create ws stubs, but npm hoists dependencies
  // So we need to install dependencies in the package directory if node_modules doesn't exist
  const pearWrkNodeModules = path.join(pearWrkPath, 'node_modules');
  if (!fs.existsSync(pearWrkNodeModules)) {
    const { execSync } = require('child_process');
    try {
      execSync('npm install --no-save', {
        cwd: pearWrkPath,
        stdio: 'pipe',
      });
      console.log('Installed dependencies for pear-wrk-wdk (needed for create-ws-stubs)');
    } catch (error) {
      console.warn('Failed to install dependencies for pear-wrk-wdk:', error.message);
    }
  }
} else {
  console.log('pear-wrk-wdk not found, skipping worker bundle fix');
}

// Fix worker bundle script path in provider package.json
if (fs.existsSync(providerPackageJsonPath)) {
  const packageJson = JSON.parse(fs.readFileSync(providerPackageJsonPath, 'utf8'));
  
  if (packageJson.scripts && packageJson.scripts['gen:worker-bundle']) {
    const currentScript = packageJson.scripts['gen:worker-bundle'];
    
    // Update path to use relative path from provider package to root node_modules
    if (currentScript.includes('node_modules/@spacesops/pear-wrk-wdk')) {
      const updatedScript = currentScript
        .replace('node_modules/@spacesops/pear-wrk-wdk/pack.imports.json', '../../@spacesops/pear-wrk-wdk/pack.imports.json')
        .replace('node_modules/@spacesops/pear-wrk-wdk/src/wdk-worklet.js', '../../@spacesops/pear-wrk-wdk/src/wdk-worklet.js');
      
      packageJson.scripts['gen:worker-bundle'] = updatedScript;
      fs.writeFileSync(providerPackageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');
      console.log('Updated gen:worker-bundle script to use correct paths');
    } else {
      console.log('gen:worker-bundle script already uses correct paths');
    }
  }
}

console.log('Bundle configuration fixes applied');

