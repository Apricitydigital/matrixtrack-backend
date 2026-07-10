import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  Alert,
  ActivityIndicator,
  TextInput,
  Platform,
  StatusBar,
  ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { apiService } from '../services/apiService';
import { useAuth } from '../context/AuthContext';
import { useTranslation } from 'react-i18next';
import {
  ATTENDANCE_STATUS,
  normalizeAttendanceStatus,
  attendanceSummaryFromEmployees,
} from '../utils/attendance';

const TodayAttendanceScreen = ({ navigation }) => {
  const { user } = useAuth();
  const { t } = useTranslation();
  const [attendanceData, setAttendanceData] = useState([]);
  const [filteredData, setFilteredData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterStatus, setFilterStatus] = useState('All');

  const statusFilters = useMemo(
    () => ['All', 'Present', ATTENDANCE_STATUS.MARKED, ATTENDANCE_STATUS.LEAVE, ATTENDANCE_STATUS.NOT_MARKED],
    []
  );

  const fetchTodayAttendance = useCallback(async () => {
    try {
      setLoading(true);
      const supervisorId = user?.user_id ?? user?.id ?? user?.userId ?? null;
      const { success, data, message, raw } = await apiService.getSupervisorEmployees(supervisorId);
      
      if (success) {
        const wardsData = data || [];
        const allEmployees = [];
        
        wardsData.forEach(ward => {
          ward.employees?.forEach(employee => {
            allEmployees.push({
              ...employee,
              ward_name: ward.ward_name,
              ward_id: ward.ward_id,
              attendance_status: normalizeAttendanceStatus(employee.attendance_status, employee),
            });
          });
        });
        
        setAttendanceData(allEmployees);
      } else {
        console.error('Today attendance API returned success: false', raw);
        if (message) {
          Alert.alert(t('common.error'), message);
        }
      }
    } catch (error) {
      console.error('Error fetching today attendance:', error);
      Alert.alert(t('common.error'), t('todayAttendance.fetchError'));
    } finally {
      setLoading(false);
    }
  }, [user?.user_id, user?.id, user?.userId]);

  useEffect(() => {
    fetchTodayAttendance();
  }, [fetchTodayAttendance]);

  useEffect(() => {
    filterAttendanceData();
  }, [attendanceData, searchQuery, filterStatus]);

  const filterAttendanceData = () => {
    let filtered = attendanceData;

    if (searchQuery) {
      filtered = filtered.filter(emp => 
        emp.emp_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        emp.emp_code.toLowerCase().includes(searchQuery.toLowerCase())
      );
    }

    if (filterStatus !== 'All') {
      if (filterStatus === 'Present') {
        filtered = filtered.filter(emp => {
          const status = normalizeAttendanceStatus(emp.attendance_status, emp);
          return status === ATTENDANCE_STATUS.MARKED || status === ATTENDANCE_STATUS.IN_PROGRESS;
        });
      } else {
        filtered = filtered.filter(emp => normalizeAttendanceStatus(emp.attendance_status, emp) === filterStatus);
      }
    }

    setFilteredData(filtered);
  };

  const onRefresh = async () => {
    setRefreshing(true);
    await fetchTodayAttendance();
    setRefreshing(false);
  };

  const statusCounts = useMemo(() => {
    const summary = attendanceSummaryFromEmployees(attendanceData);
    return {
      All: summary.total,
      Present: summary.marked + summary.inProgress,
      [ATTENDANCE_STATUS.MARKED]: summary.marked,
      [ATTENDANCE_STATUS.NOT_MARKED]: summary.notMarked,
      [ATTENDANCE_STATUS.LEAVE]: summary.leave,
      summary,
    };
  }, [attendanceData]);

  const getStatusColor = (status) => {
    switch (status) {
      case ATTENDANCE_STATUS.MARKED: return '#28a745';
      case ATTENDANCE_STATUS.IN_PROGRESS: return '#ff9800';
      case ATTENDANCE_STATUS.LEAVE: return '#17a2b8';
      case ATTENDANCE_STATUS.NOT_MARKED: return '#dc3545';
      default: return '#6c757d';
    }
  };

  const getStatusIcon = (status) => {
    switch (status) {
      case ATTENDANCE_STATUS.MARKED: return 'checkmark-circle';
      case ATTENDANCE_STATUS.IN_PROGRESS: return 'time';
      case ATTENDANCE_STATUS.LEAVE: return 'medical';
      case ATTENDANCE_STATUS.NOT_MARKED: return 'close-circle';
      default: return 'help-circle';
    }
  };

  const getStatusLabel = (status) => {
    switch (status) {
      case ATTENDANCE_STATUS.NOT_MARKED: return t('todayAttendance.absent');
      case ATTENDANCE_STATUS.MARKED: return t('todayAttendance.punchOut');
      case ATTENDANCE_STATUS.IN_PROGRESS: return t('todayAttendance.punchIn');
      case ATTENDANCE_STATUS.LEAVE: return t('todayAttendance.onLeave');
      default: return status;
    }
  };

  const getFilterLabel = (status) => {
    switch (status) {
      case 'All': return t('todayAttendance.all');
      case 'Present': return t('todayAttendance.present');
      case ATTENDANCE_STATUS.NOT_MARKED: return t('todayAttendance.absent');
      case ATTENDANCE_STATUS.MARKED: return t('todayAttendance.punchOut');
      case ATTENDANCE_STATUS.LEAVE: return t('todayAttendance.onLeave');
      default: return status;
    }
  };

  const renderEmployee = ({ item }) => {
    const normalizedStatus = normalizeAttendanceStatus(item.attendance_status, item);
    return (
      <View style={styles.employeeCard}>
        <View style={styles.employeeInfo}>
          <Text style={styles.employeeName}>{item.emp_name}</Text>
          <Text style={styles.employeeCode}>{t('todayAttendance.empId')}: {item.emp_code}</Text>
          <Text style={styles.employeeDetails}>{item.designation} ΓÇó {item.department}</Text>
          <Text style={styles.wardInfo}>≡ƒôì {item.ward_name}</Text>
        </View>
        <View style={styles.statusContainer}>
          <Ionicons
            name={getStatusIcon(normalizedStatus)}
            size={24}
            color={getStatusColor(normalizedStatus)}
          />
          <Text style={[styles.statusText, { color: getStatusColor(normalizedStatus) }]}>
            {normalizedStatus === ATTENDANCE_STATUS.LEAVE && item.leave_type
              ? `${getStatusLabel(normalizedStatus)} (${item.leave_type})`
              : getStatusLabel(normalizedStatus)}
          </Text>
        </View>
      </View>
    );
  };

  const FilterButton = ({ status, count }) => (
    <TouchableOpacity
      style={[
        styles.filterButton,
        filterStatus === status && styles.activeFilterButton
      ]}
      onPress={() => setFilterStatus(status)}
    >
      <Text style={[
        styles.filterButtonText,
        filterStatus === status && styles.activeFilterButtonText
      ]}>
        {getFilterLabel(status)} ({count})
      </Text>
    </TouchableOpacity>
  );

  if (loading && !attendanceData.length) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#007bff" />
        <Text style={styles.loadingText}>{t('todayAttendance.loadingAttendance')}</Text>
      </View>
    );
  }

  return (
    <View style={styles.mainContainer}>
      <StatusBar barStyle="light-content" />

      <View style={styles.header}>
        <View style={styles.headerTitleRow}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backButton}>
            <Ionicons name="arrow-back" size={24} color="#fff" />
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>{t('todayAttendance.title')}</Text>
            <Text style={styles.subtitle}>{t('todayAttendance.subtitle')}</Text>
          </View>
          <TouchableOpacity 
            onPress={onRefresh} 
            style={styles.headerRefreshButton}
            disabled={refreshing}
          >
            {refreshing ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Ionicons name="refresh" size={22} color="#fff" />
            )}
          </TouchableOpacity>
        </View>
      </View>

      {(loading) && (
        <View style={styles.centeredLoadingOverlay}>
          <View style={styles.loadingCard}>
            <ActivityIndicator size="large" color="#007bff" />
            <Text style={styles.loadingText}>{t('todayAttendance.updatingAttendance')}</Text>
          </View>
        </View>
      )}

      <View style={styles.content}>
        <View style={styles.searchContainer}>
          <Ionicons name="search" size={20} color="#666" style={styles.searchIcon} />
          <TextInput
            style={styles.searchInput}
            placeholder={t('todayAttendance.searchPlaceholder')}
            value={searchQuery}
            onChangeText={setSearchQuery}
          />
        </View>

        <View style={styles.filtersContainer}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingRight: 20 }}>
            {statusFilters.map((status) => (
              <FilterButton 
                key={status} 
                status={status} 
                count={statusCounts[status] || 0} 
              />
            ))}
          </ScrollView>
        </View>

        <View style={styles.summaryContainer}>
          <View style={styles.summaryCard}>
            <Text style={[styles.summaryNumber, { color: '#007bff' }]}>
              {statusCounts.Present}
            </Text>
            <Text style={styles.summaryLabel}>{t('todayAttendance.present')}</Text>
          </View>
          <View style={styles.summaryCard}>
            <Text style={styles.summaryNumber}>{statusCounts[ATTENDANCE_STATUS.MARKED]}</Text>
            <Text style={styles.summaryLabel}>{t('todayAttendance.punchOut')}</Text>
          </View>
          <View style={styles.summaryCard}>
            <Text style={[styles.summaryNumber, { color: '#dc3545' }]}>
              {statusCounts[ATTENDANCE_STATUS.NOT_MARKED]}
            </Text>
            <Text style={styles.summaryLabel}>{t('todayAttendance.absent')}</Text>
          </View>
          <View style={styles.summaryCard}>
            <Text style={[styles.summaryNumber, { color: '#17a2b8' }]}>
              {statusCounts[ATTENDANCE_STATUS.LEAVE]}
            </Text>
            <Text style={styles.summaryLabel}>{t('todayAttendance.onLeave')}</Text>
          </View>
          <View style={styles.summaryCard}>
            <Text style={[styles.summaryNumber, { color: '#666' }]}>
              {statusCounts.All > 0
                ? ((statusCounts.Present / statusCounts.All) * 100).toFixed(1)
                : 0}%
            </Text>
            <Text style={styles.summaryLabel}>{t('todayAttendance.attendance')}</Text>
          </View>
        </View>

        <FlatList
          data={filteredData}
          renderItem={renderEmployee}
          keyExtractor={(item, index) =>
            item.emp_id ? item.emp_id.toString() : `${item.emp_code || 'employee'}-${index}`
          }
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }
          showsVerticalScrollIndicator={false}
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Ionicons name="people-outline" size={64} color="#ccc" />
              <Text style={styles.emptyText}>{t('todayAttendance.noEmployees')}</Text>
            </View>
          }
        />
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  mainContainer: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  header: {
    backgroundColor: '#4361ee',
    paddingHorizontal: 20,
    paddingTop: Platform.OS === 'ios' ? 55 : 45,
    paddingBottom: 20,
    borderBottomLeftRadius: 24,
    borderBottomRightRadius: 24,
  },
  headerTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {
    fontSize: 22,
    fontWeight: '800',
    color: '#fff',
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: 14,
    color: 'rgba(255, 255, 255, 0.85)',
    marginTop: 2,
    fontWeight: '500',
  },
  headerRefreshButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  centeredLoadingOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(255, 255, 255, 0.7)',
    zIndex: 999,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingCard: {
    backgroundColor: '#fff',
    padding: 24,
    borderRadius: 20,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 10,
    elevation: 5,
  },
  loadingText: {
    marginTop: 12,
    fontSize: 14,
    fontWeight: '600',
    color: '#1e293b',
  },
  content: {
    flex: 1,
    padding: 15,
  },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: 10,
    paddingHorizontal: 15,
    marginBottom: 15,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 3.84,
    elevation: 5,
  },
  searchIcon: {
    marginRight: 10,
  },
  searchInput: {
    flex: 1,
    paddingVertical: 12,
    fontSize: 16,
  },
  filtersContainer: {
    flexDirection: 'row',
    marginBottom: 15,
  },
  filterButton: {
    backgroundColor: '#fff',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    marginRight: 10,
    borderWidth: 1,
    borderColor: '#ddd',
  },
  activeFilterButton: {
    backgroundColor: '#007bff',
    borderColor: '#007bff',
  },
  filterButtonText: {
    fontSize: 12,
    color: '#666',
    fontWeight: '500',
  },
  activeFilterButtonText: {
    color: '#fff',
  },
  summaryContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 20,
  },
  summaryCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 15,
    alignItems: 'center',
    flexBasis: '30%',
    flexGrow: 1,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 3.84,
    elevation: 5,
  },
  summaryNumber: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#28a745',
    marginBottom: 5,
  },
  summaryLabel: {
    fontSize: 12,
    color: '#666',
  },
  employeeCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 15,
    marginBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 3.84,
    elevation: 5,
  },
  employeeInfo: {
    flex: 1,
  },
  employeeName: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#333',
    marginBottom: 3,
  },
  employeeCode: {
    fontSize: 12,
    color: '#666',
    marginBottom: 3,
  },
  employeeDetails: {
    fontSize: 14,
    color: '#666',
    marginBottom: 3,
  },
  wardInfo: {
    fontSize: 12,
    color: '#007bff',
  },
  statusContainer: {
    alignItems: 'center',
    marginLeft: 15,
  },
  statusText: {
    fontSize: 10,
    fontWeight: 'bold',
    marginTop: 2,
  },
  emptyContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 50,
  },
  emptyText: {
    fontSize: 16,
    color: '#666',
    marginTop: 10,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#f5f5f5',
  },
});

export default TodayAttendanceScreen;
