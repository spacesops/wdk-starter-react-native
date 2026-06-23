import { CameraView, useCameraPermissions } from 'expo-camera';
import { useLocalSearchParams } from 'expo-router';
import { useDebouncedNavigation } from '@/hooks/use-debounced-navigation';
import { setScannedImportWords } from '@/utils/import-mnemonic-session';
import { parseTwelveWordMnemonic } from '@/utils/parse-twelve-word-mnemonic';
import * as bip39 from 'bip39';
import { X } from 'lucide-react-native';
import React, { useCallback, useMemo, useState } from 'react';
import { Alert, Dimensions, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '@/constants/colors';

const { width: screenWidth } = Dimensions.get('window');
const qrSize = screenWidth * 0.7;

export default function ScanQRScreen() {
  const insets = useSafeAreaInsets();
  const router = useDebouncedNavigation();
  const { returnRoute, scanMode, ...params } = useLocalSearchParams();
  const isMnemonicMode = scanMode === 'mnemonic';
  const [permission, requestPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState(false);

  const copy = useMemo(
    () =>
      isMnemonicMode
        ? {
            permissionBody:
              'Please allow camera access to scan a QR code containing your 12-word recovery phrase.',
            title: 'Scan QR code with your recovery phrase.',
            subtitle: 'Hold your phone up to the QR code. Only 12-word phrases are supported.',
            scanLabel: 'Scan recovery phrase',
            invalidTitle: 'Invalid QR Code',
            invalidBody:
              'The scanned QR code must contain exactly 12 lowercase words separated by spaces.',
            invalidChecksumBody:
              'This does not look like a valid 12-word recovery phrase. Check spelling and word order.',
          }
        : {
            permissionBody:
              'Please allow camera access to scan QR codes for wallet addresses.',
            title: 'Scan QR code to make payment.',
            subtitle: 'Hold your phone up to the QR code.',
            scanLabel: 'Scan address',
            invalidTitle: 'Invalid QR Code',
            invalidBody: 'The scanned QR code does not contain a valid address.',
            invalidChecksumBody: '',
          },
    [isMnemonicMode]
  );

  const handleBarCodeScanned = useCallback(
    ({ data }: { type: string; data: string }) => {
      if (scanned) return;

      setScanned(true);

      if (isMnemonicMode) {
        const words = parseTwelveWordMnemonic(data);
        if (!words) {
          Alert.alert(copy.invalidTitle, copy.invalidBody, [
            {
              text: 'Try Again',
              onPress: () => setScanned(false),
            },
          ]);
          return;
        }

        const mnemonic = words.join(' ');
        if (!bip39.validateMnemonic(mnemonic)) {
          Alert.alert(copy.invalidTitle, copy.invalidChecksumBody, [
            {
              text: 'Try Again',
              onPress: () => setScanned(false),
            },
          ]);
          return;
        }

        setScannedImportWords(words);

        if (returnRoute) {
          router.replace({ pathname: returnRoute as any });
        } else {
          router.back();
        }
        return;
      }

      if (!data || data.length < 10) {
        Alert.alert(copy.invalidTitle, copy.invalidBody, [
          {
            text: 'Try Again',
            onPress: () => setScanned(false),
          },
        ]);
        return;
      }

      if (returnRoute) {
        router.replace({
          pathname: returnRoute as any,
          params: { scannedAddress: data, ...params },
        });
      } else {
        router.replace({
          pathname: '/send/select-token',
          params: { scannedAddress: data, ...params },
        });
      }
    },
    [scanned, router, returnRoute, params, isMnemonicMode, copy]
  );

  const handleClose = useCallback(() => {
    router.back();
  }, [router]);

  const handleRequestPermission = useCallback(async () => {
    const result = await requestPermission();
    if (!result.granted) {
      Alert.alert('Camera Permission Required', copy.permissionBody);
    }
  }, [requestPermission, copy.permissionBody]);

  // Show loading while checking permission
  if (permission === null) {
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <View style={styles.headerSpacer} />
          <TouchableOpacity style={styles.closeButton} onPress={handleClose}>
            <X size={24} color={colors.primary} />
          </TouchableOpacity>
        </View>
        <View style={styles.centerContent}>
          <Text style={styles.centerText}>Checking camera permission...</Text>
        </View>
      </View>
    );
  }

  // Show permission request if not granted
  if (!permission.granted) {
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <View style={styles.headerSpacer} />
          <TouchableOpacity style={styles.closeButton} onPress={handleClose}>
            <X size={24} color={colors.primary} />
          </TouchableOpacity>
        </View>
        <View style={styles.centerContent}>
          <Text style={styles.centerTitle}>Camera Permission Required</Text>
          <Text style={styles.centerText}>{copy.permissionBody}</Text>
          <TouchableOpacity style={styles.permissionButton} onPress={handleRequestPermission}>
            <Text style={styles.permissionButtonText}>Enable Camera</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerSpacer} />
        <TouchableOpacity style={styles.closeButton} onPress={handleClose}>
          <X size={24} color="#AA4981" />
        </TouchableOpacity>
      </View>

      {/* Title Section */}
      <View style={styles.titleSection}>
        <Text style={styles.title}>{copy.title}</Text>
        <Text style={styles.subtitle}>{copy.subtitle}</Text>
      </View>

      {/* Camera View */}
      <View style={styles.cameraContainer}>
        <CameraView style={styles.camera} facing="back" onBarcodeScanned={handleBarCodeScanned}>
          {/* Custom Overlay */}
          <View style={styles.overlay}>
            <View style={styles.scanFrame}>
              {/* Corner borders */}
              <View style={[styles.corner, styles.topLeft]} />
              <View style={[styles.corner, styles.topRight]} />
              <View style={[styles.corner, styles.bottomLeft]} />
              <View style={[styles.corner, styles.bottomRight]} />
            </View>

            <View style={styles.scanInfo}>
              <Text style={styles.scanLabel}>{copy.scanLabel}</Text>
            </View>
          </View>
        </CameraView>
      </View>

      {/* Bottom Section */}
      <View style={styles.bottomSection} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
  },
  headerSpacer: {
    width: 24,
  },
  closeButton: {
    padding: 4,
  },
  titleSection: {
    paddingHorizontal: 20,
    paddingBottom: 40,
  },
  title: {
    fontSize: 20,
    fontWeight: '600',
    color: colors.text,
    textAlign: 'center',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    color: colors.textSecondary,
    textAlign: 'center',
  },
  cameraContainer: {
    flex: 1,
    margin: 20,
    borderRadius: 16,
    overflow: 'hidden',
  },
  camera: {
    flex: 1,
  },
  overlay: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
  },
  scanFrame: {
    width: qrSize,
    height: qrSize,
    position: 'relative',
  },
  corner: {
    position: 'absolute',
    width: 20,
    height: 20,
    borderColor: colors.white,
  },
  topLeft: {
    top: 0,
    left: 0,
    borderTopWidth: 3,
    borderLeftWidth: 3,
  },
  topRight: {
    top: 0,
    right: 0,
    borderTopWidth: 3,
    borderRightWidth: 3,
  },
  bottomLeft: {
    bottom: 0,
    left: 0,
    borderBottomWidth: 3,
    borderLeftWidth: 3,
  },
  bottomRight: {
    bottom: 0,
    right: 0,
    borderBottomWidth: 3,
    borderRightWidth: 3,
  },
  scanInfo: {
    marginTop: 30,
    alignItems: 'center',
  },
  scanLabel: {
    fontSize: 16,
    color: colors.white,
    fontWeight: '500',
    textShadowColor: 'rgba(0, 0, 0, 0.75)',
    textShadowOffset: { width: -1, height: 1 },
    textShadowRadius: 10,
  },
  bottomSection: {
    paddingHorizontal: 20,
    paddingBottom: 40,
    alignItems: 'center',
  },
  bottomText: {
    fontSize: 16,
    color: colors.textSecondary,
    marginBottom: 16,
  },
  bottomLine: {
    width: 100,
    height: 2,
    backgroundColor: colors.border,
    borderRadius: 1,
  },
  centerContent: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 40,
  },
  centerTitle: {
    fontSize: 20,
    fontWeight: '600',
    color: colors.text,
    textAlign: 'center',
    marginBottom: 16,
  },
  centerText: {
    fontSize: 16,
    color: colors.textSecondary,
    textAlign: 'center',
    lineHeight: 24,
    marginBottom: 32,
  },
  permissionButton: {
    backgroundColor: colors.primary,
    paddingHorizontal: 32,
    paddingVertical: 16,
    borderRadius: 12,
  },
  permissionButtonText: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '600',
  },
});
