import { File, Paths } from 'expo-file-system';
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';

/**
 * Write JSON to the cache directory and open the native share sheet.
 */
export async function saveKeystoreJson(fileName: string, data: unknown): Promise<void> {
  const content = JSON.stringify(data, null, 2);
  const file = new File(Paths.cache, fileName);
  if (file.exists) {
    file.delete();
  }
  file.create();
  file.write(content);

  if (!(await Sharing.isAvailableAsync())) {
    throw new Error('Sharing is not available on this device');
  }

  await Sharing.shareAsync(file.uri, {
    mimeType: 'application/json',
    dialogTitle: 'Save keystore backup',
  });
}

/**
 * Pick a JSON file via the document picker and parse it.
 * Throws with `error.name === 'UserCancel'` when the user dismisses the picker.
 */
export async function openKeystoreJson(): Promise<{ data: unknown; filename: string }> {
  const result = await DocumentPicker.getDocumentAsync({
    type: 'application/json',
    multiple: false,
  });

  if (result.canceled) {
    const error = new Error('File selection canceled');
    error.name = 'UserCancel';
    throw error;
  }

  const asset = result.assets[0];
  if (!asset.name?.toLowerCase().endsWith('.json')) {
    throw new Error('Please select a JSON file');
  }
  if (!asset.uri) {
    throw new Error('No file URI available');
  }

  const response = await fetch(asset.uri);
  const fileContent = await response.text();

  try {
    const data = JSON.parse(fileContent);
    return { data, filename: asset.name };
  } catch {
    throw new Error('Invalid JSON format in file');
  }
}
