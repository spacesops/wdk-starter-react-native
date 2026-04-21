import Header from '@/components/header';
import {
  type RecordRow,
  type RecordType,
  RECOMMENDED_KEYS,
  bytesToHex,
  decodeRecordSet,
  encodeRecordSet,
  hexToBytes,
  isValidHex,
  jsonToRows,
  rowsToJson,
  validateJsonRecords,
  validateKey,
} from '@/lib/wire';
import { colors } from '@/constants/colors';
import { useDebouncedNavigation } from '@/hooks/use-debounced-navigation';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Clipboard from 'expo-clipboard';
import { useLocalSearchParams } from 'expo-router';
import { Copy, Download, Ellipsis, Trash2, Upload } from 'lucide-react-native';
import type { ChangeEvent } from 'react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const WIRE_HEX_KEY = 'wire_hex';
const LEGACY_VTLV_KEY = 'vltv_hex';
const MY_SPACES_KEY = 'mySpaces';

const RECORD_TYPES: { type: RecordType; label: string }[] = [
  { type: 'seq', label: 'SEQ' },
  { type: 'txt', label: 'TXT' },
  { type: 'blob', label: 'BLOB' },
];

const KEY_CATEGORIES = ['Spaces Protocol', 'Payment Addresses', 'Identity & Keys', 'General'] as const;

function getPlaceholder(row: RecordRow): string {
  if (row.recordType === 'seq') return '0';
  if (row.key && RECOMMENDED_KEYS[row.key]) {
    return RECOMMENDED_KEYS[row.key].placeholder;
  }
  if (row.recordType === 'blob') return 'base64 encoded data';
  return 'Enter value...';
}

function getKeyLabel(key: string): string {
  return RECOMMENDED_KEYS[key]?.label ?? key;
}

export default function HexToolScreen() {
  const insets = useSafeAreaInsets();
  const router = useDebouncedNavigation();
  const {
    subspace,
    spaceName,
    listnumsLastDataHex,
    newDataHex: newDataHexParam,
    seedWireFromSubspace: seedWireFromSubspaceParam,
    chainPresence: chainPresenceParam,
  } = useLocalSearchParams<{
    subspace?: string;
    spaceName?: string;
    listnumsLastDataHex?: string;
    newDataHex?: string;
    /** '1' when opened from Subspace → Hex Tool (seed / clear from listnums-by-spk result). */
    seedWireFromSubspace?: string;
    chainPresence?: string;
  }>();

  const [hexString, setHexString] = useState('');
  const [tableRows, setTableRows] = useState<RecordRow[]>([]);
  const [selectedRowForType, setSelectedRowForType] = useState<string | null>(null);
  const [selectedRowForKey, setSelectedRowForKey] = useState<string | null>(null);
  const [hexCopied, setHexCopied] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const isUpdatingFromHex = useRef(false);
  const isUpdatingFromRows = useRef(false);

  const recalculateHex = useCallback((rows: RecordRow[]) => {
    if (isUpdatingFromHex.current) return;
    isUpdatingFromRows.current = true;
    try {
      const bytes = encodeRecordSet(rows);
      setHexString(bytesToHex(bytes));
    } catch {
      // encoding error — leave hex as-is
    } finally {
      isUpdatingFromRows.current = false;
    }
  }, []);

  const handleTextChange = (text: string) => {
    if (text.length > 0 && !isValidHex(text)) {
      const invalidCharMatch = text.match(/[^0-9A-Fa-f]/);
      const invalidChar = invalidCharMatch ? invalidCharMatch[0] : 'unknown';
      Alert.alert(
        'Invalid Hex Character',
        `The character "${invalidChar}" is not a valid hexadecimal digit.\n\nOnly hexadecimal digits (0-9, A-F, a-f) are allowed.`,
        [{ text: 'OK' }]
      );
      return;
    }
    setHexString(text.toUpperCase());
  };

  const handleHexBlur = () => {
    if (!hexString || hexString.length === 0 || hexString.length % 2 !== 0) return;
    if (!isValidHex(hexString)) return;

    isUpdatingFromHex.current = true;
    try {
      const bytes = hexToBytes(hexString);
      const rows = decodeRecordSet(bytes);
      setTableRows(rows);
    } catch {
      // malformed data — don't update table
    } finally {
      isUpdatingFromHex.current = false;
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const seedFromSubspace = seedWireFromSubspaceParam === '1';
        const chainPresence =
          chainPresenceParam === 'on-chain' || chainPresenceParam === 'off-chain'
            ? chainPresenceParam
            : undefined;

        if (seedFromSubspace && chainPresence != null) {
          let nextHex = '';
          let nextRows: RecordRow[] = [];
          if (chainPresence === 'off-chain') {
            nextHex = '';
            nextRows = [];
          } else {
            const h = listnumsLastDataHex ? String(listnumsLastDataHex).trim() : '';
            if (/^[0-9A-Fa-f]*$/.test(h) && h.length % 2 === 0 && h.length > 0) {
              nextHex = h.toUpperCase();
              try {
                nextRows = decodeRecordSet(hexToBytes(nextHex));
              } catch {
                nextRows = [];
              }
            }
          }
          if (!cancelled) {
            setHexString(nextHex);
            setTableRows(nextRows);
          }
          return;
        }

        let initial: string | null = null;
        if (newDataHexParam != null && String(newDataHexParam).length > 0) {
          const nd = String(newDataHexParam).trim();
          if (/^[0-9A-Fa-f]*$/.test(nd) && nd.length % 2 === 0) {
            initial = nd.toUpperCase();
          }
        }
        if (initial == null || initial === '') {
          initial = await AsyncStorage.getItem(WIRE_HEX_KEY);
        }
        if (initial == null || initial === '') {
          const legacy = await AsyncStorage.getItem(LEGACY_VTLV_KEY);
          if (legacy && legacy.length > 0) {
            initial = legacy;
          }
        }
        if (!cancelled && (initial == null || initial === '') && listnumsLastDataHex) {
          const h = String(listnumsLastDataHex).trim();
          if (/^[0-9A-Fa-f]*$/.test(h) && h.length % 2 === 0 && h.length > 0) {
            initial = h.toUpperCase();
          }
        }
        if (!cancelled && initial) {
          setHexString(initial);
          try {
            const bytes = hexToBytes(initial);
            const rows = decodeRecordSet(bytes);
            if (!cancelled) setTableRows(rows);
          } catch {
            setTableRows([]);
          }
        }
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    listnumsLastDataHex,
    newDataHexParam,
    seedWireFromSubspaceParam,
    chainPresenceParam,
  ]);

  useEffect(() => {
    if (!hydrated) return;
    AsyncStorage.setItem(WIRE_HEX_KEY, hexString);
  }, [hexString, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    if (isUpdatingFromHex.current) return;
    recalculateHex(tableRows);
  }, [tableRows, recalculateHex, hydrated]);

  const getLengthByteDecimal = (): number | null => {
    if (hexString.length === 0) return null;
    return Math.floor(hexString.length / 2);
  };

  const copyToClipboard = async () => {
    if (hexString.length === 0) {
      Alert.alert('Nothing to Copy', 'The hex string is empty.');
      return;
    }
    try {
      await Clipboard.setStringAsync(hexString);
      setHexCopied(true);
      setTimeout(() => setHexCopied(false), 2000);
    } catch {
      Alert.alert('Error', 'Failed to copy to clipboard.');
    }
  };

  const downloadJson = () => {
    if (Platform.OS !== 'web') {
      Alert.alert('Not Available', 'Download is only available on web.');
      return;
    }
    try {
      if (tableRows.length === 0) {
        Alert.alert('Nothing to Download', 'The record table is empty.');
        return;
      }
      const jsonData = rowsToJson(tableRows);
      const jsonString = JSON.stringify(jsonData, null, 2);
      const blob = new Blob([jsonString], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      const handlePart =
        subspace && spaceName ? `${String(subspace).trim()}@${String(spaceName).trim().toLowerCase()}` : 'wire-records';
      link.download = `${handlePart}-${Date.now()}.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      Alert.alert('Downloaded!', 'JSON file downloaded successfully.');
    } catch {
      Alert.alert('Error', 'Failed to download JSON file.');
    }
  };

  const uploadJson = () => {
    if (Platform.OS !== 'web') {
      Alert.alert('Not Available', 'Upload is only available on web.');
      return;
    }
    fileInputRef.current?.click();
  };

  const handleFileUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const records = validateJsonRecords(parsed);
      const rows = jsonToRows(records);
      setTableRows(rows);
      Alert.alert('Success!', `Loaded ${rows.length} record(s) from JSON file.`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to parse JSON file.';
      Alert.alert(
        'Upload Error',
        `Could not parse JSON file:\n\n${errorMessage}\n\nExpected wire JSON: an array of { type, key?, value?, version? } records.`
      );
    }
  };

  const hasSeq = tableRows.some((r) => r.recordType === 'seq');

  const updateRow = (id: string, updates: Partial<RecordRow>) => {
    setTableRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...updates } : r)));
  };

  const deleteRow = (id: string) => {
    setTableRows((prev) => prev.filter((r) => r.id !== id));
  };

  const insertRow = (recordType: 'txt' | 'blob' | 'seq' = 'txt') => {
    const newRow: RecordRow = {
      id: Date.now().toString(),
      recordType,
      key: recordType === 'txt' || recordType === 'blob' ? '' : undefined,
      value: recordType === 'seq' ? undefined : '',
      version: recordType === 'seq' ? 0 : undefined,
    };
    if (recordType === 'seq') {
      setTableRows((prev) => [newRow, ...prev]);
    } else {
      setTableRows((prev) => [...prev, newRow]);
    }
  };

  const contextSubtitle =
    subspace && spaceName ? `${subspace}@${String(spaceName).toLowerCase()}` : null;

  const canSaveToSpace = Boolean(subspace && spaceName);

  const handleSaveHexString = async () => {
    if (!subspace || !spaceName) {
      Alert.alert('Cannot Save', 'Open Hex Tool from a space to save to that space.');
      return;
    }
    const trimmed = hexString.trim().toUpperCase();
    if (trimmed.length > 0 && (trimmed.length % 2 !== 0 || !isValidHex(trimmed))) {
      Alert.alert('Invalid Hex', 'Use an even number of hexadecimal digits, or leave empty.');
      return;
    }
    try {
      await AsyncStorage.setItem(WIRE_HEX_KEY, trimmed);
      const raw = await AsyncStorage.getItem(MY_SPACES_KEY);
      if (!raw) {
        Alert.alert('Not Found', 'No spaces list in storage.');
        return;
      }
      const spaces = JSON.parse(raw) as Array<{
        subspace: string;
        spaceName: string;
        newDataHex?: string;
        [key: string]: unknown;
      }>;
      const sn = String(spaceName).toLowerCase();
      const idx = spaces.findIndex((s) => s.subspace === subspace && s.spaceName === sn);
      if (idx < 0) {
        Alert.alert('Not Found', 'This space is not in My Spaces.');
        return;
      }
      spaces[idx] = { ...spaces[idx], newDataHex: trimmed };
      await AsyncStorage.setItem(MY_SPACES_KEY, JSON.stringify(spaces));
      router.back();
    } catch (e) {
      Alert.alert('Error', e instanceof Error ? e.message : 'Save failed');
    }
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <Header title="Hex Tool" />
      {contextSubtitle ? (
        <Text style={styles.contextHint}>{contextSubtitle}</Text>
      ) : null}
      <ScrollView style={styles.scrollView} contentContainerStyle={styles.scrollContent}>
        <View style={styles.textInputContainer}>
          <View style={styles.labelContainer}>
            <Text style={styles.label}>Wire Hex String</Text>
            {(() => {
              const lengthDecimal = getLengthByteDecimal();
              return lengthDecimal !== null ? (
                <>
                  <Text
                    style={[
                      styles.lengthLabel,
                      lengthDecimal > 75 && styles.lengthLabelOverLimit,
                    ]}>
                    {' '}({lengthDecimal} bytes)
                  </Text>
                  <TouchableOpacity
                    style={styles.copyButton}
                    onPress={copyToClipboard}
                    accessibilityLabel="Copy hex string to clipboard">
                    <Copy size={18} color={colors.text} />
                  </TouchableOpacity>
                  {hexCopied ? <Text style={styles.flashMessage}>Copied!</Text> : null}
                  <TouchableOpacity
                    style={styles.copyButton}
                    onPress={downloadJson}
                    accessibilityLabel="Download JSON file">
                    <Download size={18} color={colors.text} />
                  </TouchableOpacity>
                </>
              ) : null;
            })()}
            <TouchableOpacity style={styles.copyButton} onPress={uploadJson} accessibilityLabel="Upload JSON file">
              <Upload size={18} color={colors.text} />
            </TouchableOpacity>
            {Platform.OS === 'web' ? (
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,application/json"
                style={{ display: 'none' }}
                onChange={handleFileUpload}
              />
            ) : null}
          </View>
          <TextInput
            testID="wire-hex"
            style={styles.textInput}
            value={hexString}
            onChangeText={handleTextChange}
            onBlur={handleHexBlur}
            multiline
            editable
            selectTextOnFocus
            placeholder="Wire hex will appear here..."
            placeholderTextColor={colors.textSecondary}
          />
        </View>

        <View style={styles.separator} />

        <View style={styles.tableContainer}>
          <View style={styles.table}>
            <View style={[styles.tableHeader, { borderBottomColor: colors.borderDark, backgroundColor: colors.cardDark }]}>
              <View style={[styles.tableHeaderCellType, styles.tableHeaderCell]}>
                <Text style={styles.tableHeaderText}>Type</Text>
              </View>
              <View style={[styles.tableHeaderCellKey, styles.tableHeaderCell]}>
                <Text style={styles.tableHeaderText}>Key</Text>
              </View>
              <View style={[styles.tableHeaderCellValue, styles.tableHeaderCell]}>
                <Text style={styles.tableHeaderText}>Value</Text>
              </View>
              <View style={styles.tableHeaderCellActions}>
                <Ellipsis size={18} color={colors.textSecondary} />
              </View>
            </View>
            {tableRows.map((row) => (
              <View key={row.id} style={[styles.tableRow, { borderBottomColor: colors.borderDark }]}>
                <View style={[styles.tableCellType, styles.tableCell]}>
                  <TouchableOpacity
                    style={styles.dropdownButton}
                    onPress={() => setSelectedRowForType(row.id)}
                    activeOpacity={0.7}>
                    <Text style={styles.dropdownButtonText}>{row.recordType.toUpperCase()}</Text>
                  </TouchableOpacity>
                </View>
                <View style={[styles.tableCellKey, styles.tableCell]}>
                  {row.recordType === 'seq' ? (
                    <Text style={styles.naLabel}>--</Text>
                  ) : (
                    <TouchableOpacity
                      style={styles.dropdownButton}
                      onPress={() => setSelectedRowForKey(row.id)}
                      activeOpacity={0.7}>
                      <Text style={styles.dropdownButtonText} numberOfLines={1}>
                        {row.key ? getKeyLabel(row.key) : 'select key...'}
                      </Text>
                    </TouchableOpacity>
                  )}
                </View>
                <View style={[styles.tableCellValue, styles.tableCell]}>
                  {row.recordType === 'seq' ? (
                    <TextInput
                      style={styles.tableInput}
                      value={row.version?.toString() ?? '0'}
                      onChangeText={(text) => {
                        const num = parseInt(text, 10);
                        updateRow(row.id, { version: isNaN(num) ? 0 : Math.max(0, num) });
                      }}
                      keyboardType="numeric"
                      placeholder="0"
                      placeholderTextColor={colors.textSecondary}
                    />
                  ) : (
                    <TextInput
                      style={styles.tableInput}
                      value={row.value ?? ''}
                      onChangeText={(text) => updateRow(row.id, { value: text })}
                      placeholder={getPlaceholder(row)}
                      placeholderTextColor={colors.textSecondary}
                      autoCapitalize="none"
                      autoCorrect={false}
                    />
                  )}
                </View>
                <View style={styles.tableCellActions}>
                  <TouchableOpacity
                    style={styles.rowDeleteBtn}
                    onPress={() => deleteRow(row.id)}
                    activeOpacity={0.7}>
                    <Trash2 size={18} color={colors.error} />
                  </TouchableOpacity>
                </View>
              </View>
            ))}
          </View>
          <View style={styles.insertGroup}>
            <TouchableOpacity
              style={styles.insertButton}
              onPress={() => insertRow('txt')}
              activeOpacity={0.7}>
              <Text style={styles.insertButtonText}>+ TXT</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.insertButton}
              onPress={() => insertRow('blob')}
              activeOpacity={0.7}>
              <Text style={styles.insertButtonText}>+ BLOB</Text>
            </TouchableOpacity>
          </View>
        </View>

        <Modal
          visible={selectedRowForType !== null}
          transparent
          animationType="fade"
          onRequestClose={() => setSelectedRowForType(null)}>
          <View style={styles.modalOverlay}>
            <Pressable style={StyleSheet.absoluteFill} onPress={() => setSelectedRowForType(null)} />
            <View style={styles.modalCard}>
              <Text style={styles.modalTitle}>Record Type</Text>
              {RECORD_TYPES.map((rt) => {
                const row = tableRows.find((r) => r.id === selectedRowForType);
                const isSeqDisabled = rt.type === 'seq' && hasSeq && row?.recordType !== 'seq';
                return (
                  <TouchableOpacity
                    key={rt.type}
                    style={[styles.modalOption, { borderBottomColor: colors.borderDark }]}
                    disabled={isSeqDisabled}
                    onPress={() => {
                      if (!selectedRowForType) return;
                      const current = tableRows.find((r) => r.id === selectedRowForType);
                      const newFields: Partial<RecordRow> = { recordType: rt.type };
                      if (rt.type === 'seq') {
                        newFields.version = 0;
                        newFields.key = undefined;
                        newFields.value = undefined;
                      } else {
                        newFields.key = current?.key ?? '';
                        newFields.value = current?.value ?? '';
                        newFields.version = undefined;
                      }
                      updateRow(selectedRowForType, newFields);
                      setSelectedRowForType(null);
                    }}
                    activeOpacity={0.7}>
                    <View style={[styles.modalOptionContent, isSeqDisabled && { opacity: 0.4 }]}>
                      <Text style={styles.modalOptionName}>{rt.label}</Text>
                      <Text style={styles.modalOptionType}>
                        0x{rt.type === 'seq' ? '00' : rt.type === 'txt' ? '01' : '02'}
                      </Text>
                    </View>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        </Modal>

        <Modal
          visible={selectedRowForKey !== null}
          transparent
          animationType="fade"
          onRequestClose={() => setSelectedRowForKey(null)}>
          <View style={styles.modalOverlay}>
            <Pressable style={StyleSheet.absoluteFill} onPress={() => setSelectedRowForKey(null)} />
            <View style={[styles.modalCard, styles.keyModalCard]}>
              <Text style={styles.modalTitle}>Select Key</Text>
              <ScrollView style={styles.keyModalScroll}>
                <View style={[styles.customKeyRow, { borderBottomColor: colors.borderDark }]}>
                  <Text style={styles.customKeyLabel}>Custom:</Text>
                  <TextInput
                    style={styles.customKeyInput}
                    placeholder="custom-key"
                    placeholderTextColor={colors.textSecondary}
                    autoCapitalize="none"
                    autoCorrect={false}
                    onSubmitEditing={(e) => {
                      const key = e.nativeEvent.text.trim();
                      if (key && validateKey(key) && selectedRowForKey) {
                        updateRow(selectedRowForKey, { key });
                        setSelectedRowForKey(null);
                      } else if (key && !validateKey(key)) {
                        Alert.alert('Invalid Key', 'Keys must only contain a-z, 0-9, and hyphens.');
                      }
                    }}
                  />
                </View>
                {KEY_CATEGORIES.map((category) => (
                  <View key={category}>
                    <View style={[styles.categoryHeader, { backgroundColor: colors.cardDark }]}>
                      <Text style={styles.categoryText}>{category}</Text>
                    </View>
                    {Object.entries(RECOMMENDED_KEYS)
                      .filter(([, info]) => info.category === category)
                      .map(([key, info]) => (
                        <TouchableOpacity
                          key={key}
                          style={[styles.modalOption, { borderBottomColor: colors.borderDark }]}
                          onPress={() => {
                            if (selectedRowForKey) {
                              updateRow(selectedRowForKey, { key });
                              setSelectedRowForKey(null);
                            }
                          }}
                          activeOpacity={0.7}>
                          <View style={styles.modalOptionContent}>
                            <Text style={styles.modalOptionName}>{info.label}</Text>
                            <Text style={styles.modalOptionType}>{key}</Text>
                          </View>
                        </TouchableOpacity>
                      ))}
                  </View>
                ))}
              </ScrollView>
            </View>
          </View>
        </Modal>
      </ScrollView>

      <View style={[styles.saveFooter, { paddingBottom: Math.max(insets.bottom, 16) }]}>
        <TouchableOpacity
          style={[styles.saveButton, !canSaveToSpace && styles.saveButtonDisabled]}
          onPress={handleSaveHexString}
          disabled={!canSaveToSpace}
          activeOpacity={0.7}
          accessibilityState={{ disabled: !canSaveToSpace }}
          accessibilityLabel="Save hex string and return to space">
          <Text style={[styles.saveButtonText, !canSaveToSpace && styles.saveButtonTextDisabled]}>
            Save Hex String
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  scrollView: {
    flex: 1,
  },
  contextHint: {
    paddingHorizontal: 20,
    paddingTop: 8,
    fontSize: 14,
    color: colors.textSecondary,
  },
  scrollContent: {
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 40,
    gap: 16,
  },
  textInputContainer: {
    marginBottom: 8,
  },
  labelContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    marginBottom: 8,
  },
  label: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.text,
  },
  lengthLabel: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.textSecondary,
    opacity: 0.85,
  },
  lengthLabelOverLimit: {
    color: colors.error,
    opacity: 1,
  },
  copyButton: {
    marginLeft: 8,
    padding: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  flashMessage: {
    marginLeft: 8,
    fontSize: 13,
    fontWeight: '600',
    color: colors.success,
  },
  textInput: {
    minHeight: 120,
    maxHeight: 220,
    padding: 12,
    borderWidth: 1,
    borderColor: colors.borderDark,
    borderRadius: 8,
    backgroundColor: colors.card,
    color: colors.text,
    fontSize: 14,
    fontFamily: 'monospace',
    textAlignVertical: 'top',
  },
  separator: {
    height: 1,
    width: '100%',
    backgroundColor: colors.borderDark,
    marginVertical: 8,
  },
  tableContainer: {
    marginBottom: 16,
  },
  table: {
    borderWidth: 1,
    borderColor: colors.borderDark,
    borderRadius: 8,
    overflow: 'hidden',
    marginBottom: 12,
  },
  tableHeader: {
    flexDirection: 'row',
    borderBottomWidth: 1,
  },
  tableHeaderCell: {
    padding: 10,
    borderRightWidth: 1,
    borderRightColor: colors.borderDark,
    justifyContent: 'center',
  },
  tableHeaderCellType: {
    width: 76,
  },
  tableHeaderCellKey: {
    width: 110,
  },
  tableHeaderCellValue: {
    flex: 1,
  },
  tableHeaderCellActions: {
    width: 44,
    padding: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tableHeaderText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.text,
    textTransform: 'uppercase',
  },
  tableRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
  },
  tableCell: {
    padding: 6,
    borderRightWidth: 1,
    borderRightColor: colors.borderDark,
    justifyContent: 'center',
  },
  tableCellType: {
    width: 76,
  },
  tableCellKey: {
    width: 110,
  },
  tableCellValue: {
    flex: 1,
  },
  tableCellActions: {
    width: 44,
    padding: 6,
    justifyContent: 'center',
    alignItems: 'center',
  },
  naLabel: {
    textAlign: 'center',
    opacity: 0.4,
    color: colors.textSecondary,
  },
  dropdownButton: {
    padding: 8,
    borderWidth: 1,
    borderColor: colors.borderDark,
    borderRadius: 4,
    backgroundColor: colors.card,
    minHeight: 40,
    justifyContent: 'center',
  },
  dropdownButtonText: {
    fontSize: 13,
    color: colors.text,
  },
  tableInput: {
    padding: 8,
    borderWidth: 1,
    borderColor: colors.borderDark,
    borderRadius: 4,
    backgroundColor: colors.card,
    fontSize: 13,
    color: colors.text,
    minHeight: 40,
  },
  rowDeleteBtn: {
    padding: 6,
    borderWidth: 1,
    borderColor: colors.borderDark,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 32,
    minHeight: 32,
  },
  insertGroup: {
    flexDirection: 'row',
    gap: 8,
  },
  insertButton: {
    flex: 1,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  insertButtonText: {
    color: colors.black,
    fontSize: 14,
    fontWeight: '600',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalCard: {
    width: '88%',
    maxWidth: 320,
    borderRadius: 8,
    padding: 16,
    backgroundColor: colors.card,
    zIndex: 2,
  },
  keyModalCard: {
    maxHeight: '70%',
  },
  keyModalScroll: {
    maxHeight: 400,
  },
  modalTitle: {
    marginBottom: 12,
    fontSize: 16,
    fontWeight: '600',
    color: colors.text,
  },
  modalOption: {
    padding: 14,
    borderBottomWidth: 1,
  },
  modalOptionContent: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  modalOptionName: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.text,
  },
  modalOptionType: {
    fontSize: 12,
    color: colors.textSecondary,
    opacity: 0.85,
  },
  customKeyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 4,
    borderBottomWidth: 1,
  },
  customKeyLabel: {
    marginRight: 8,
    fontWeight: '600',
    color: colors.text,
  },
  customKeyInput: {
    flex: 1,
    padding: 8,
    borderWidth: 1,
    borderColor: colors.borderDark,
    borderRadius: 4,
    backgroundColor: colors.background,
    fontSize: 14,
    color: colors.text,
    minHeight: 36,
  },
  categoryHeader: {
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
  categoryText: {
    fontSize: 11,
    textTransform: 'uppercase',
    opacity: 0.7,
    color: colors.textSecondary,
    fontWeight: '600',
  },
  saveFooter: {
    paddingHorizontal: 20,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: colors.borderDark,
    backgroundColor: colors.background,
  },
  saveButton: {
    backgroundColor: colors.primary,
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveButtonDisabled: {
    opacity: 0.45,
  },
  saveButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.black,
  },
  saveButtonTextDisabled: {
    opacity: 0.85,
  },
});
